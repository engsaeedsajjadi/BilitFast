# -*- coding: utf-8 -*-
"""
هسته منطقی برنامه BilitFast — نسخه تحت وب.

این ماژول منطق برنامه دسکتاپی (BilitFast.py) را بدون وابستگی به PyQt5 / ویندوز
حفظ می‌کند. تنها بخش‌هایی که به محیط دسکتاپ وابسته بودند (رجیستری، باز کردن
Firefox، pyautogui/pyperclip) با معادل وب جایگزین شده‌اند:

  - TrialManager  : ذخیره در فایل trial.json  (به‌جای رجیستری ویندوز)
  - SessionSingleton / DynamicRateLimiter : بدون تغییر
  - استخراج قطارها، ساخت داده جستجو، ارسال درخواست : بدون تغییر
  - رزرو نهایی    : تولید همان فایل HTML فرم، اما به‌جای بازکردن خودکار Firefox
                    فایل برای دانلود به کاربر داده می‌شود.
"""

import os
import re
import json
import time
import threading
import logging
import subprocess
import tempfile
from datetime import datetime, timedelta

import requests
import urllib3
from lxml import html
import jdatetime

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

logger = logging.getLogger("bilitfast")

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def resource_path(relative_path):
    """مسیر فایل‌های همراه برنامه (سازگار با PyInstaller در حالت عادی)."""
    try:
        base_path = getattr(__import__("sys"), "_MEIPASS")
    except Exception:
        base_path = BASE_DIR
    return os.path.join(base_path, relative_path)


# ---------------------------------------------------------------------------
# مدیریت دوره آزمایشی و فعال‌سازی (نسخه فایلی به‌جای رجیستری)
# ---------------------------------------------------------------------------
class TrialManager:
    """ مدیریت دوره آزمایشی و فعال‌سازی دائمی (ذخیره در فایل JSON). """
    TRIAL_PERIOD_DAYS = 2
    ACTIVATION_CODE = "Sa@0946517835"
    TRIAL_FILE = os.path.join(BASE_DIR, "trial.json")

    def __init__(self):
        self.start_date = None
        self.activated = False
        self.load_trial_info()

    def load_trial_info(self):
        try:
            with open(self.TRIAL_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
            start_date_str = data.get("StartDate")
            self.start_date = (
                datetime.fromisoformat(start_date_str) if start_date_str else None
            )
            self.activated = bool(data.get("Activated", False))
        except (FileNotFoundError, ValueError, json.JSONDecodeError):
            self.start_date = None
            self.activated = False

    def save_trial_info(self):
        try:
            data = {
                "StartDate": self.start_date.isoformat() if self.start_date else "",
                "Activated": int(self.activated),
            }
            with open(self.TRIAL_FILE, "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
        except Exception as e:
            logger.error("خطا در ذخیره اطلاعات دوره آزمایشی: %s", e)

    def start_trial(self):
        if self.start_date is None:
            self.start_date = datetime.now()
            self.save_trial_info()

    def trial_expired(self):
        if self.activated:
            return False
        if self.start_date is None:
            return True
        return datetime.now() > self.start_date + timedelta(days=self.TRIAL_PERIOD_DAYS)

    def activate_permanently(self):
        self.activated = True
        self.save_trial_info()


# ---------------------------------------------------------------------------
# مدیریت نشست (Session) و Rate Limiter — بدون تغییر نسبت به نسخه اصلی
# ---------------------------------------------------------------------------
class SessionSingleton:
    _instance = None
    _lock = threading.Lock()

    @staticmethod
    def get_instance():
        if SessionSingleton._instance is None:
            with SessionSingleton._lock:
                if SessionSingleton._instance is None:
                    SessionSingleton._instance = requests.Session()
        return SessionSingleton._instance


class DynamicRateLimiter:
    def __init__(self, parent_app, base_interval=0.5):
        self.parent_app = parent_app
        self.lock = threading.Lock()
        self.last_request_time = 0
        self.base_interval = base_interval

    def wait_before_request(self):
        with self.lock:
            route_count = max(1, self.parent_app.route_count)
            min_interval = self.base_interval * route_count
            now = time.time()
            elapsed = now - self.last_request_time
            if elapsed < min_interval:
                to_wait = min_interval - elapsed
                logger.debug("[RateLimiter] انتظار %.2f ثانیه...", to_wait)
                time.sleep(to_wait)
            self.last_request_time = time.time()


# ---------------------------------------------------------------------------
# کلاس اصلی برنامه (معادل TrainReservationApp بدون Qt)
# ---------------------------------------------------------------------------
class ReservationEngine:
    """پورت منطق TrainReservationApp به یک کلاس ساده (بدون Qt)."""

    def __init__(self):
        self.config = {}
        self.city_codes = {}
        self.session = SessionSingleton.get_instance()
        self.route_count = 0
        self.route_search_data = {}   # route_id -> search_data
        self.route_status = {}        # route_id -> (text, color)
        self.route_running = {}       # route_id -> bool
        self.route_found_trains = {}  # route_id -> list[dict]
        self.route_passengers = {}    # route_id -> list[dict]
        self.route_fields = {}        # route_id -> form fields (cities, date, gender, train)
        self.route_workers = {}       # route_id -> WorkerThread
        self.search_cache = {}

        self.load_config()
        self.load_cities()
        self.load_state()

        self.rate_limiter = DynamicRateLimiter(
            self, base_interval=float(self.config.get("rate_limit_base_interval", 0.5))
        )
        self.concurrency_semaphore = threading.Semaphore(value=3)

    # ------------------------- پیکربندی -------------------------
    def load_config(self):
        default_config = {
            "base_url": "https://safirrail.ir",
            "search_url": "/etrain/searchWagn.php",
            "reserve_url": "/etrain/TresV.php",
            "refresh_interval": 5,
            "user_agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
            "content_type": "application/x-www-form-urlencoded",
            "accept": "*/*",
            "train_row_selector": "tr[name='srvc']",
            "train_number_selector": "td:nth-child(3)",
            "departure_time_selector": "td:nth-child(8)",
            "capacity_selector": "td:nth-child(9)",
            "availability_selector": "td:nth-child(9)",
            "price_selector": "td:nth-child(10)",
            "coupe_selector": "td:nth-child(4)",
            "company_selector": "td:nth-child(2) > div",
            "srvc_checkbox_selector": "input[name='srvc']",
            "max_routes": 10,
            "rate_limit_base_interval": 0.5,
            # تنظیمات ورود به سامانه (قابل ویرایش در config.json)
            "login_url": "/fa/UserAut.php",
            "login_action": "Login",
            "login_user_field": "user",
            "login_pass_field": "pass",
            "login_extra_data": {},
        }
        try:
            with open(resource_path("config.json"), "r", encoding="utf-8") as f:
                file_config = json.load(f)
        except (FileNotFoundError, json.JSONDecodeError) as e:
            logger.warning("config.json یافت نشد یا نامعتبر است: %s", e)
            file_config = {}

        self.config = default_config
        self.config.update(file_config)

    def save_config(self):
        try:
            with open(resource_path("config.json"), "w", encoding="utf-8") as f:
                json.dump(self.config, f, ensure_ascii=False, indent=2)
        except Exception as e:
            logger.error("خطا در ذخیره config.json: %s", e)

    # ------------------------- شهرها -------------------------
    def load_cities(self):
        json_path = resource_path("cities.json")
        if os.path.exists(json_path):
            try:
                with open(json_path, "r", encoding="utf-8") as f:
                    data = json.load(f)
                if isinstance(data, dict):
                    self.city_codes = data
                else:
                    logger.error("فرمت فایل cities.json معتبر نیست.")
            except Exception as e:
                logger.error("خطا در لود شهرها: %s", e)
        else:
            logger.error("فایل cities.json یافت نشد.")

    # ------------------------- ذخیره/بازیابی وضعیت -------------------------
    @property
    def state_file(self):
        return os.path.join(BASE_DIR, "state.json")

    def save_state(self):
        state = {"routes": list(self.route_search_data.keys())}
        for route_id, route_data in self.route_search_data.items():
            state[str(route_id)] = route_data
        # ذخیره فیلدهای فرم و مسافران هر مسیر
        state["route_fields"] = {str(k): v for k, v in self.route_fields.items()}
        state["route_passengers"] = {str(k): v for k, v in self.route_passengers.items()}
        try:
            with open(self.state_file, "w", encoding="utf-8") as f:
                json.dump(state, f, ensure_ascii=False, indent=2)
        except Exception as e:
            logger.error("خطا در ذخیره state.json: %s", e)

    def load_state(self):
        try:
            with open(self.state_file, "r", encoding="utf-8") as f:
                state = json.load(f)
        except (FileNotFoundError, json.JSONDecodeError):
            return
        if not state:
            return
        routes = state.get("routes", [])
        route_fields = state.get("route_fields", {})
        route_passengers = state.get("route_passengers", {})
        for route_id in routes:
            try:
                route_id_int = int(route_id)
                if route_id_int > self.route_count:
                    self.route_count = route_id_int
                route_data = state.get(str(route_id))
                if route_data:
                    self.route_search_data[route_id_int] = route_data
                self.route_fields[route_id_int] = route_fields.get(str(route_id), {})
                self.route_passengers[route_id_int] = route_passengers.get(str(route_id), [])
                self.route_status[route_id_int] = ("جستجو متوقف شد", "red")
                self.route_running[route_id_int] = False
                self.route_found_trains[route_id_int] = []
            except ValueError:
                logger.error("شناسه مسیر نامعتبر: %s", route_id)

    # ------------------------- ارسال درخواست -------------------------
    def _send_request(self, url, data, method="post", headers=None,
                      max_retries=5, backoff_factor=0.5):
        base_url = self.config["base_url"]
        default_headers = {
            "User-Agent": self.config.get("user_agent", ""),
            "Content-Type": self.config.get("content_type", "application/x-www-form-urlencoded"),
            "Accept": self.config.get("accept", "*/*"),
            "Referer": base_url + "/etrain/index.php",
            "Origin": base_url,
        }
        if headers:
            default_headers.update(headers)

        attempt = 1
        while attempt <= max_retries:
            self.rate_limiter.wait_before_request()
            try:
                if method.lower() == "post":
                    resp = self.session.post(url, data=data, headers=default_headers, verify=False, timeout=30)
                else:
                    resp = self.session.get(url, headers=default_headers, verify=False, timeout=30)
                resp.raise_for_status()
                return resp
            except requests.exceptions.RequestException as e:
                logger.error("خطا در ارسال درخواست (attempt %d): %s", attempt, e)
                if attempt < max_retries:
                    sleep_time = backoff_factor * (2 ** (attempt - 1))
                    logger.debug("انتظار %.2f ثانیه قبل از تلاش مجدد...", sleep_time)
                    time.sleep(sleep_time)
                    attempt += 1
                else:
                    return None

    def _send_search_request(self, search_data):
        full_url = self.config["base_url"] + self.config["search_url"]
        logger.debug("داده‌های ارسالی: %s", search_data)
        return self._send_request(full_url, search_data, "post", max_retries=50, backoff_factor=0.5)

    # ------------------------- ساخت داده جستجو -------------------------
    def _build_search_data(self, from_code, to_code, departure_date,
                           gender_str, passengers, train_number,
                           adult=1, child=0, infant=0, foreigner=0, return_date=None):
        gender_map = {"عادی": "3", "برادران": "2", "خواهران": "1"}
        if not return_date:
            return_date = departure_date
        data = {
            "from": from_code,
            "to": to_code,
            "pathWay": "1",
            "fromd": departure_date,
            "tod": return_date,
            "sex": gender_map.get(gender_str, "3"),
            "adult": str(adult),
            "shahed": "0",
            "child": str(child),
            "infant": str(infant),
            "forien": str(foreigner),
            "passCnt": str(passengers),
            "srvc": "",
            "departureTrain": train_number,
            "returnTrain": "",
            "groupWay": "on",
            "tmpDate": departure_date,
        }
        return data

    # ------------------------- استخراج قطارها -------------------------
    def extract_trains(self, html_text, capacity_needed=0, specific_train_number=None):
        tree = html.fromstring(html_text)
        rows = tree.cssselect(self.config["train_row_selector"])
        results = []
        for row in rows:
            try:
                train_num = row.cssselect(self.config["train_number_selector"])[0].text_content().strip()
                if specific_train_number and train_num != specific_train_number:
                    continue
                time_text = row.cssselect(self.config["departure_time_selector"])[0].text_content().strip()
                cap_text = row.cssselect(self.config["capacity_selector"])[0].text_content().strip()
                avail_text = row.cssselect(self.config["availability_selector"])[0].text_content().strip()
                price_el = row.cssselect(self.config["price_selector"])
                price_text = price_el[0].text_content().strip() if price_el else "نامشخص"
                coupe_el = row.cssselect(self.config["coupe_selector"])
                coupe_text = coupe_el[0].text_content().strip() if coupe_el else "نامشخص"
                checkbox = row.cssselect(self.config["srvc_checkbox_selector"])[0]
                srvc = checkbox.get("value", "")
                a_match = re.search(r"(\d+)", avail_text)
                total_capacity = int(a_match.group(1)) if a_match else 0
                if total_capacity >= capacity_needed:
                    train_info = {
                        "شماره قطار": train_num,
                        "ساعت حرکت": time_text,
                        "قیمت": price_text,
                        "نوع کوپه": coupe_text,
                        "ظرفیت": total_capacity,
                        "srvc": srvc,
                    }
                    results.append(train_info)
            except Exception as e:
                logger.error("خطا در استخراج قطار: %s", e)
        return results

    # ------------------------- ورود به سامانه -------------------------
    def login(self, username, password):
        """ورود به سامانه صفیر ریل و انتقال کوکی‌ها به نشست برنامه."""
        login_url = self.config["base_url"] + self.config.get("login_url", "/fa/UserAut.php")
        data = {
            self.config.get("login_user_field", "user"): username,
            self.config.get("login_pass_field", "pass"): password,
        }
        # اکشن ورود (در صورت وجود)
        action = self.config.get("login_action")
        if action:
            data["Action"] = action
        extra = self.config.get("login_extra_data", {})
        if isinstance(extra, dict):
            data.update(extra)

        try:
            resp = self.session.post(login_url, data=data, verify=False, timeout=30,
                                     headers={"User-Agent": self.config.get("user_agent", "")})
            resp.raise_for_status()
        except requests.exceptions.RequestException as e:
            logger.error("خطا در ورود: %s", e)
            return False, f"خطا در ارتباط با سامانه: {e}"

        # بررسی موفقیت ورود بر اساس نشانگر قابل تنظیم
        marker = self.config.get("login_success_marker")
        if marker:
            success = marker in resp.text
        else:
            # اگر نشانگری تعریف نشده، تلاش می‌کنیم کوکی سشن ست شده باشد
            success = len(self.session.cookies) > 0
        if success:
            logger.info("ورود موفقیت‌آمیز بود.")
            return True, "ورود موفقیت‌آمیز بود."
        return False, "ورود ناموفق بود (شناسه یا گذرواژه اشتباه، یا فیلدهای فرم نادرست)."

    # ------------------------- مدیریت مسیرها -------------------------
    def add_route(self):
        max_routes = int(self.config.get("max_routes", 10))
        if self.route_count >= max_routes:
            return None, f"حداکثر {max_routes} مسیر مجاز است."
        self.route_count += 1
        route_id = self.route_count
        self.route_status[route_id] = ("در انتظار جستجو", "gray")
        self.route_running[route_id] = False
        self.route_found_trains[route_id] = []
        self.route_fields[route_id] = {
            "from_city": "تهران" if "تهران" in self.city_codes else "",
            "to_city": "مشهد" if "مشهد" in self.city_codes else "",
            "date": jdatetime.date.today().strftime("%Y/%m/%d"),
            "gender": "عادی",
            "train_number": "",
        }
        self.route_passengers[route_id] = []
        self.save_state()
        return route_id, None

    def remove_route(self, route_id):
        worker = self.route_workers.pop(route_id, None)
        if worker:
            worker.stop()
        self.route_search_data.pop(route_id, None)
        self.route_status.pop(route_id, None)
        self.route_running.pop(route_id, None)
        self.route_found_trains.pop(route_id, None)
        self.route_fields.pop(route_id, None)
        self.route_passengers.pop(route_id, None)
        self.route_count -= 1
        if self.route_count < 0:
            self.route_count = 0
        self.save_state()

    def close_all_routes(self):
        for route_id in list(self.route_workers.keys()):
            self.route_workers[route_id].stop()

    def update_route_status(self, route_id, status_text, color="black"):
        self.route_status[route_id] = (status_text, color)

    # ------------------------- جستجو -------------------------
    def start_search(self, route_id, fields, passengers):
        """آغاز جستجوی پس‌زمینه برای یک مسیر (معادل Worker در نسخه اصلی)."""
        from_city = fields.get("from_city", "")
        to_city = fields.get("to_city", "")
        date_str = (fields.get("date") or "").strip()
        gender_str = fields.get("gender", "عادی")
        train_number = (fields.get("train_number") or "").strip()

        from_code = self.city_codes.get(from_city)
        to_code = self.city_codes.get(to_city)

        # اعتبارسنجی تاریخ شمسی
        try:
            jdatetime.datetime.strptime(date_str, "%Y/%m/%d")
        except ValueError:
            return False, "فرمت تاریخ اشتباه است."

        # شمارش مسافران بر اساس نوع سهمیه
        adult = child = infant = foreigner = 0
        for p in passengers:
            qt = p.get("quota_type", "بزرگسال")
            if qt == "بزرگسال":
                adult += 1
            elif qt == "خردسال":
                child += 1
            elif qt == "کودک":
                infant += 1
            elif qt == "اتباع":
                foreigner += 1
        total = adult + child + infant + foreigner

        if not (from_code and to_code and date_str and total > 0):
            return False, "ورودی‌ها ناقص است"

        search_data = self._build_search_data(
            from_code, to_code, date_str, gender_str, total, train_number,
            adult=adult, child=child, infant=infant, foreigner=foreigner
        )
        self.route_search_data[route_id] = search_data
        self.route_fields[route_id] = fields
        self.route_passengers[route_id] = passengers
        self.save_state()

        # توقف کارگر قبلی در صورت وجود
        old = self.route_workers.pop(route_id, None)
        if old:
            old.stop()

        worker = WorkerThread(self, route_id, search_data)
        self.route_workers[route_id] = worker
        self.route_running[route_id] = True
        worker.start()
        return True, "جستجو آغاز شد..."

    def stop_search(self, route_id):
        worker = self.route_workers.get(route_id)
        if worker:
            worker.stop()
        self.route_running[route_id] = False
        self.update_route_status(route_id, "جستجو متوقف شد", "red")

    # ------------------------- رزرو -------------------------
    def perform_reservation(self, route_id, selected_train):
        """تولید فرم HTML رزرو (معادل perform_reservation نسخه اصلی)."""
        route_data = self.route_search_data.get(route_id, {})
        if not route_data:
            return False, "اطلاعات رزرو ناقص است.", None

        from_code = route_data.get("from", "")
        to_code = route_data.get("to", "")
        departure_date = route_data.get("fromd", "")
        train_number = selected_train.get("شماره قطار", "")
        srvc_value = selected_train.get("srvc", "")
        gender_str = self.route_fields.get(route_id, {}).get("gender", "عادی")

        adult = int(route_data.get("adult", 1))
        child = int(route_data.get("child", 0))
        infant = int(route_data.get("infant", 0))
        foreigner = int(route_data.get("forien", 0))
        passengers = int(route_data.get("passCnt", 1))

        if not all([from_code, to_code, departure_date, train_number, srvc_value]):
            return False, "اطلاعات رزرو ناقص است (srvc خالی یا داده ناقص).", None

        reserve_data = self._build_search_data(
            from_code, to_code, departure_date, gender_str, passengers,
            train_number, adult=adult, child=child, infant=infant, foreigner=foreigner
        )
        reserve_data["srvc"] = srvc_value
        logger.debug("داده‌های رزرو: %s", reserve_data)

        # ساخت همان فرم HTML نسخه اصلی
        form_html = '<html><head><meta charset="UTF-8"></head><body onload="document.forms[0].submit();">'
        form_html += '<form action="%s%s" method="POST">' % (
            self.config["base_url"], self.config["reserve_url"]
        )
        for key, value in reserve_data.items():
            escaped_value = value.replace('"', "&quot;") if isinstance(value, str) else value
            form_html += '<input type="hidden" name="%s" value="%s"/>' % (key, escaped_value)
        form_html += "</form></body></html>"

        return True, form_html, reserve_data

    # ------------------------- آماده‌سازی داده مسافران -------------------------
    def passenger_rows(self, route_id):
        """بازگرداندن ردیف‌های مسافر (معادل prepare_passenger_data_for_paste)."""
        return self.route_passengers.get(route_id, [])

    # ------------------------- داده برای UI -------------------------
    def route_summary(self, route_id):
        data = self.route_search_data.get(route_id)
        fields = self.route_fields.get(route_id, {})
        status_text, status_color = self.route_status.get(route_id, ("", "black"))

        from_city = to_city = date = train_num = capacity = ""
        if data is not None:
            from_code = data.get("from", "")
            to_code = data.get("to", "")
            from_cities = [k for k, v in self.city_codes.items() if str(v) == str(from_code)]
            to_cities = [k for k, v in self.city_codes.items() if str(v) == str(to_code)]
            from_city = from_cities[0] if from_cities else from_code
            to_city = to_cities[0] if to_cities else to_code
            date = data.get("fromd", "")
            train_num = data.get("departureTrain", "")
            capacity = data.get("passCnt", "")
        else:
            from_city = fields.get("from_city", "")
            to_city = fields.get("to_city", "")
            date = fields.get("date", "")

        return {
            "id": route_id,
            "from": from_city,
            "to": to_city,
            "date": date,
            "train_number": train_num,
            "capacity": capacity,
            "status": status_text,
            "status_color": status_color,
            "running": self.route_running.get(route_id, False),
        }


# ---------------------------------------------------------------------------
# کارگر جستجو (معادل Worker در نسخه اصلی، اما با threading به‌جای QRunnable)
# ---------------------------------------------------------------------------
class WorkerThread(threading.Thread):
    def __init__(self, engine, route_id, search_data):
        super().__init__(daemon=True)
        self.engine = engine
        self.route_id = route_id
        self.search_data = search_data
        self.stop_flag = False
        self._lock = threading.Lock()

    def stop(self):
        with self._lock:
            self.stop_flag = True

    def _stopped(self):
        with self._lock:
            return self.stop_flag

    def run(self):
        engine = self.engine
        with engine.concurrency_semaphore:
            refresh_interval = float(engine.config.get("refresh_interval", 5))
            while not self._stopped():
                found = self.do_one_attempt()
                if found:
                    engine.route_running[self.route_id] = False
                    return
                time.sleep(refresh_interval)
        engine.route_running[self.route_id] = False

    def do_one_attempt(self):
        if self._stopped():
            return False
        engine = self.engine
        search_resp = engine._send_search_request(self.search_data)
        if not search_resp:
            engine.update_route_status(self.route_id, "خطا در دریافت پاسخ جستجو.", "red")
            return False
        capacity_needed = (
            int(self.search_data.get("adult", 0)) +
            int(self.search_data.get("child", 0)) +
            int(self.search_data.get("infant", 0)) +
            int(self.search_data.get("forien", 0))
        )
        available_trains = engine.extract_trains(
            search_resp.text,
            capacity_needed=capacity_needed,
            specific_train_number=self.search_data.get("departureTrain"),
        )
        if not available_trains:
            engine.update_route_status(self.route_id, "هیچ قطاری با ظرفیت کافی یافت نشد.", "orange")
            return False
        engine.route_found_trains[self.route_id] = available_trains
        engine.update_route_status(self.route_id, "قطار یافت شد!", "green")
        return True
