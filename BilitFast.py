import sys
import os
import json
from datetime import datetime, timedelta
from PyQt5.QtWidgets import QApplication, QMessageBox, QInputDialog
import winreg
import sys
from PyQt5.QtWidgets import QApplication
import time

# ------------------------- منطق دوره آزمایشی -------------------------
class TrialManager:
    """ مدیریت دوره آزمایشی و فعالسازی دائمی برنامه در رجیستری ویندوز """
    REGISTRY_PATH = r"SOFTWARE\MyTrialApp"
    TRIAL_PERIOD_DAYS = 2
    ACTIVATION_CODE = "Sa@0946517835"

    def __init__(self):
        self.start_date = None
        self.activated = False
        self.load_trial_info()

    def load_trial_info(self):
        """ خواندن اطلاعات دوره آزمایشی از رجیستری """
        try:
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, self.REGISTRY_PATH, 0, winreg.KEY_READ) as key:
                start_date_str, _ = winreg.QueryValueEx(key, "StartDate")
                activated, _ = winreg.QueryValueEx(key, "Activated")
                
                self.start_date = datetime.fromisoformat(start_date_str) if start_date_str else None
                self.activated = bool(activated)
        except FileNotFoundError:
            self.start_date = None
            self.activated = False

    def save_trial_info(self):
        """ ذخیره اطلاعات نسخه آزمایشی در رجیستری """
        try:
            with winreg.CreateKey(winreg.HKEY_CURRENT_USER, self.REGISTRY_PATH) as key:
                winreg.SetValueEx(key, "StartDate", 0, winreg.REG_SZ, self.start_date.isoformat() if self.start_date else "")
                winreg.SetValueEx(key, "Activated", 0, winreg.REG_DWORD, int(self.activated))
        except Exception as e:
            print("❌ خطا در ذخیره اطلاعات رجیستری:", e)

    def start_trial(self):
        """ اگر تاریخ شروع هنوز تنظیم نشده باشد، مقداردهی اولیه انجام می‌شود. """
        if self.start_date is None:
            self.start_date = datetime.now()
            self.save_trial_info()

    def trial_expired(self):
        """ بررسی انقضای دوره آزمایشی """
        if self.activated:
            return False
        if self.start_date is None:
            return True
        return datetime.now() > self.start_date + timedelta(days=self.TRIAL_PERIOD_DAYS)

    def activate_permanently(self):
        """ فعالسازی دائمی برنامه """
        self.activated = True
        self.save_trial_info()

def check_trial(trial_manager):
    """ بررسی دوره آزمایشی و درخواست کد فعال‌سازی در صورت نیاز """
    if trial_manager.start_date is None:
        response = QMessageBox.question(
            None,
            "شروع دوره آزمایشی",
            "آیا مایل به شروع دوره آزمایشی 2 روزه هستید؟",
            QMessageBox.Yes | QMessageBox.No
        )
        if response == QMessageBox.Yes:
            trial_manager.start_trial()
        else:
            sys.exit(0)

    if trial_manager.trial_expired():
        code, ok = QInputDialog.getText(
            None,
            "فعالسازی",
            "دوره آزمایشی شما به پایان رسیده است.\nلطفاً کد فعالسازی را وارد کنید:"
        )
        if ok and code == TrialManager.ACTIVATION_CODE:
            trial_manager.activate_permanently()
            QMessageBox.information(None, "فعالسازی", "✅ برنامه به صورت دائمی فعال شد.")
        else:
            QMessageBox.information(None, "فعالسازی", "❌ کد فعالسازی نادرست است.\nبرنامه بسته خواهد شد.")
            sys.exit(0)

# -------------------------- کد اصلی سیستم رزرو بلیت --------------------------
import requests
import platform
import urllib3
from PyQt5.QtMultimedia import QSound
from PyQt5.QtWidgets import (
    QWidget, QVBoxLayout, QLabel, QPushButton, QHBoxLayout,
    QComboBox, QRadioButton, QButtonGroup,
    QGridLayout, QDialog, QTableWidget, QTableWidgetItem,
    QProgressBar, QLineEdit, QSpinBox, QCalendarWidget,
    QFileDialog
)
from PyQt5.QtGui import QFont, QPixmap
from PyQt5.QtCore import (
    Qt, QUrl, QObject, pyqtSignal, QThreadPool, QTimer, QDate,
    QRunnable, pyqtSlot, QSettings
)
import logging
import pyautogui
import pyperclip
import re
import threading
from lxml import html
import jdatetime
from datetime import timedelta, datetime
import browser_cookie3
import subprocess
import tempfile

# غیرفعال کردن هشدارهای درخواست‌های ناامن
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

# تنظیمات لاگینگ
logger = logging.getLogger()
logger.setLevel(logging.DEBUG)
formatter = logging.Formatter('%(asctime)s:%(levelname)s:%(message)s')
file_handler = logging.FileHandler('train_reservation.log', encoding='utf-8')
file_handler.setLevel(logging.DEBUG)
file_handler.setFormatter(formatter)
logger.addHandler(file_handler)
stream_handler = logging.StreamHandler()
stream_handler.setLevel(logging.INFO)
stream_handler.setFormatter(formatter)
logger.addHandler(stream_handler)

def resource_path(relative_path):
    try:
        base_path = sys._MEIPASS
    except Exception:
        base_path = os.path.abspath(".")
    return os.path.join(base_path, relative_path)

def get_default_firefox_path():
    system = platform.system()
    if system == "Windows":
        return r"C:\Program Files\Mozilla Firefox\firefox.exe"
    elif system == "Linux":
        return "/usr/bin/firefox"
    elif system == "Darwin":
        return "/Applications/Firefox.app/Contents/MacOS/firefox"
    return ""

def get_default_firefox_profile_path():
    system = platform.system()
    if system == "Windows":
        return os.path.join(os.getenv("APPDATA"), "Mozilla", "Firefox", "Profiles")
    elif system == "Linux":
        return os.path.join(os.path.expanduser("~"), ".mozilla", "firefox")
    elif system == "Darwin":
        return os.path.join(os.path.expanduser("~"), "Library", "Application Support", "Firefox", "Profiles")
    return ""

class SettingsDialog(QDialog):
    def __init__(self, parent=None):
        super().__init__(parent)
        self.setWindowTitle("تنظیمات")
        self.setMinimumSize(500, 200)
        self.initUI()

    def initUI(self):
        layout = QVBoxLayout()
        layout.addWidget(QLabel("مسیر اجرایی Firefox:"))
        self.firefox_exe_edit = QLineEdit()
        browse_exe_btn = QPushButton("مرور...")
        browse_exe_btn.clicked.connect(self.browse_firefox_exe)
        exe_layout = QHBoxLayout()
        exe_layout.addWidget(self.firefox_exe_edit)
        exe_layout.addWidget(browse_exe_btn)
        layout.addLayout(exe_layout)
        layout.addWidget(QLabel("مسیر پروفایل Firefox:"))
        self.firefox_profile_edit = QLineEdit()
        browse_profile_btn = QPushButton("مرور...")
        browse_profile_btn.clicked.connect(self.browse_firefox_profile)
        profile_layout = QHBoxLayout()
        profile_layout.addWidget(self.firefox_profile_edit)
        profile_layout.addWidget(browse_profile_btn)
        layout.addLayout(profile_layout)
        btn_layout = QHBoxLayout()
        save_btn = QPushButton("ذخیره")
        save_btn.clicked.connect(self.accept)
        cancel_btn = QPushButton("لغو")
        cancel_btn.clicked.connect(self.reject)
        btn_layout.addWidget(save_btn)
        btn_layout.addWidget(cancel_btn)
        layout.addLayout(btn_layout)
        self.setLayout(layout)

    def browse_firefox_exe(self):
        file_path, _ = QFileDialog.getOpenFileName(self, "انتخاب فایل اجرایی Firefox", "", "Executable Files (*.exe)")
        if file_path:
            self.firefox_exe_edit.setText(file_path)

    def browse_firefox_profile(self):
        dir_path = QFileDialog.getExistingDirectory(self, "انتخاب پروفایل Firefox")
        if dir_path:
            self.firefox_profile_edit.setText(dir_path)

    def get_settings(self):
        return {
            "firefox_exe_path": self.firefox_exe_edit.text(),
            "firefox_profile_path": self.firefox_profile_edit.text()
        }

class SessionSingleton:
    _instance = None
    @staticmethod
    def get_instance():
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
                logging.debug(f"[RateLimiter] انتظار {to_wait:.2f} ثانیه...")
                time.sleep(to_wait)
            self.last_request_time = time.time()

class WorkerSignals(QObject):
    finished = pyqtSignal()
    progress = pyqtSignal(str, str)
    train_found = pyqtSignal(list)
    error_signal = pyqtSignal(str)

class Worker(QRunnable):
    def __init__(self, parent_app, route_id, search_data):
        super().__init__()
        self.parent_app = parent_app
        self.route_id = route_id
        self.search_data = search_data
        self.signals = WorkerSignals()
        self.stop_flag = False

    @pyqtSlot()
    def run(self):
        with self.parent_app.concurrency_semaphore:
            refresh_interval = self.parent_app.config.get("refresh_interval", 5)
            while not self.stop_flag:
                found = self.do_one_attempt()
                if found:
                    self.signals.finished.emit()
                    return
                time.sleep(refresh_interval)
        self.signals.finished.emit()

    def do_one_attempt(self):
        if self.stop_flag:
            return False
        search_resp = self.parent_app._send_search_request(self.search_data)
        if not search_resp:
            self.signals.error_signal.emit("خطا در دریافت پاسخ جستجو.")
            return False
        capacity_needed = (
            int(self.search_data.get("adult", 0)) +
            int(self.search_data.get("child", 0)) +
            int(self.search_data.get("infant", 0)) +
            int(self.search_data.get("forien", 0))
        )
        available_trains = self.parent_app.extract_trains(
            search_resp,
            capacity_needed=capacity_needed,
            specific_train_number=self.search_data.get("departureTrain")
        )
        if not available_trains:
            self.signals.progress.emit("هیچ قطاری با ظرفیت کافی یافت نشد.", "orange")
            return False
        self.signals.train_found.emit(available_trains)
        return True

    def stop(self):
        self.stop_flag = True

class JalaliCalendarDialog(QDialog):
    def __init__(self, parent=None):
        super().__init__(parent)
        self.setWindowTitle("انتخاب تاریخ شمسی")
        self.setMinimumSize(300, 400)
        self.selected_date = None
        self.initUI()

    def initUI(self):
        layout = QVBoxLayout()
        self.calendar = QCalendarWidget()
        self.calendar.setGridVisible(True)
        layout.addWidget(self.calendar)
        btn_layout = QHBoxLayout()
        prev_day_btn = QPushButton("روز قبل")
        prev_day_btn.clicked.connect(self.prev_day)
        btn_layout.addWidget(prev_day_btn)
        next_day_btn = QPushButton("روز بعد")
        next_day_btn.clicked.connect(self.next_day)
        btn_layout.addWidget(next_day_btn)
        select_btn = QPushButton("انتخاب")
        select_btn.clicked.connect(self.select_date)
        btn_layout.addWidget(select_btn)
        cancel_btn = QPushButton("لغو")
        cancel_btn.clicked.connect(self.reject)
        btn_layout.addWidget(cancel_btn)
        layout.addLayout(btn_layout)
        self.setLayout(layout)

    def prev_day(self):
        current_date = self.calendar.selectedDate().toPyDate()
        jalali_date = jdatetime.date.fromgregorian(date=current_date)
        jalali_prev = jalali_date - timedelta(days=1)
        gregorian_prev = jalali_prev.togregorian()
        self.calendar.setSelectedDate(QDate(gregorian_prev.year, gregorian_prev.month, gregorian_prev.day))

    def next_day(self):
        current_date = self.calendar.selectedDate().toPyDate()
        jalali_date = jdatetime.date.fromgregorian(date=current_date)
        jalali_next = jalali_date + timedelta(days=1)
        gregorian_next = jalali_next.togregorian()
        self.calendar.setSelectedDate(QDate(gregorian_next.year, gregorian_next.month, gregorian_next.day))

    def select_date(self):
        gregorian_date = self.calendar.selectedDate().toPyDate()
        jalali_date = jdatetime.date.fromgregorian(date=gregorian_date)
        self.selected_date = jalali_date
        self.accept()

class TrainSelectionDialog(QDialog):
    def __init__(self, available_trains, parent=None):
        super().__init__(parent)
        self.setWindowFlags(Qt.Window | Qt.WindowMinMaxButtonsHint | Qt.WindowCloseButtonHint)
        self.setMinimumSize(700, 400)
        self.available_trains = available_trains
        self.selected_train = None
        self.initUI()

    def initUI(self):
        layout = QVBoxLayout()
        info_label = QLabel("یکی از قطارهای زیر را انتخاب کنید:")
        info_label.setFont(QFont('Helvetica', 14, QFont.Bold))
        info_label.setAlignment(Qt.AlignCenter)
        layout.addWidget(info_label)
        self.table = QTableWidget()
        self.table.setRowCount(len(self.available_trains))
        self.table.setColumnCount(5)
        self.table.setHorizontalHeaderLabels(["شماره قطار", "نوع", "ساعت", "تاریخ", "موجودی بلیت"])
        self.table.setEditTriggers(QTableWidget.NoEditTriggers)
        self.table.setSelectionBehavior(QTableWidget.SelectRows)
        self.table.setSelectionMode(QTableWidget.SingleSelection)
        self.table.horizontalHeader().setStretchLastSection(True)
        self.table.verticalHeader().setVisible(False)
        self.table.setStyleSheet("background-color: rgba(255, 255, 255, 210);")
        for i, train in enumerate(self.available_trains):
            self.table.setItem(i, 0, QTableWidgetItem(train.get("شماره قطار", "")))
            self.table.setItem(i, 1, QTableWidgetItem(train.get("ساعت حرکت", "")))
            self.table.setItem(i, 2, QTableWidgetItem(train.get("قیمت", "")))
            self.table.setItem(i, 3, QTableWidgetItem(train.get("نوع کوپه", "")))
            self.table.setItem(i, 4, QTableWidgetItem(str(train.get("ظرفیت", 0))))
        layout.addWidget(self.table)
        btn_layout = QHBoxLayout()
        select_btn = QPushButton("انتخاب")
        select_btn.setShortcut("Enter")
        select_btn.clicked.connect(self.select_train)
        btn_layout.addWidget(select_btn)
        cancel_btn = QPushButton("لغو")
        cancel_btn.setShortcut("Esc")
        cancel_btn.clicked.connect(self.reject)
        btn_layout.addWidget(cancel_btn)
        layout.addLayout(btn_layout)
        self.setLayout(layout)

    def select_train(self):
        selected_rows = self.table.selectionModel().selectedRows()
        if not selected_rows:
            QMessageBox.warning(self, "هشدار", "یک سطر را انتخاب کنید.")
            return
        row = selected_rows[0].row()
        train_number = self.table.item(row, 0).text()
        for tr in self.available_trains:
            if tr["شماره قطار"] == train_number:
                self.selected_train = tr
                self.accept()
                return
        QMessageBox.warning(self, "هشدار", "قطار یافت نشد.")

class TrainReservationApp(QWidget):
    def __init__(self):
        super().__init__()
        self.setWindowFlags(Qt.Window | Qt.WindowMinMaxButtonsHint | Qt.WindowCloseButtonHint)
        self.setMinimumSize(1000, 600)
        self.settings = QSettings("YourCompany", "TrainReservationApp")
        self.config = {}
        self.city_codes = {}
        self.session = SessionSingleton.get_instance()
        self.route_count = 0
        self.route_windows = {}
        self.route_search_data = {}
        self.search_cache = {}
        self.load_config()
        if not self.config.get("firefox_exe_path") or not self.config.get("firefox_profile_path"):
            self.open_settings()
        self.load_cities()
        self.load_state()
        self.rate_limiter = DynamicRateLimiter(self, base_interval=self.config.get("rate_limit_base_interval", 0.5))
        self.concurrency_semaphore = threading.Semaphore(value=3)
        self.threadpool = QThreadPool()
        self.initUI()

    def open_settings(self):
        dialog = SettingsDialog(self)
        if dialog.exec_() == QDialog.Accepted:
            settings = dialog.get_settings()
            self.config["firefox_exe_path"] = settings["firefox_exe_path"]
            self.config["firefox_profile_path"] = settings["firefox_profile_path"]
            self.save_config()
            QMessageBox.information(self, "موفقیت", "تنظیمات ذخیره شد.")

    def initUI(self):
        self.setWindowTitle("Bilit Fast - سامانه خرید بلیط قطار")
        main_layout = QVBoxLayout()
        header_widget = QWidget()
        header_layout = QHBoxLayout()
        header_widget.setLayout(header_layout)
        header_pixmap = QPixmap(resource_path("header_background.jpg"))
        if not header_pixmap.isNull():
            header_label = QLabel()
            header_label.setPixmap(header_pixmap)
            header_label.setScaledContents(True)
            header_label.setFixedHeight(100)
            header_layout.addWidget(header_label)
        else:
            header_label = QLabel("Bilit Fast")
            header_label.setFont(QFont('Helvetica', 24, QFont.Bold))
            header_label.setAlignment(Qt.AlignCenter)
            header_layout.addWidget(header_label)
        main_layout.addWidget(header_widget)
        btn_layout = QHBoxLayout()
        self.btn_settings = QPushButton("تنظیمات")
        self.btn_settings.setShortcut("Ctrl+P")
        self.btn_settings.clicked.connect(self.open_settings)
        btn_layout.addWidget(self.btn_settings)
        self.btn_login = QPushButton("ورود (Firefox)")
        self.btn_login.setShortcut("Ctrl+L")
        self.btn_login.clicked.connect(self.open_firefox_profile)
        btn_layout.addWidget(self.btn_login)
        self.btn_add_route = QPushButton("افزودن مسیر جدید")
        self.btn_add_route.setShortcut("Ctrl+A")
        self.btn_add_route.clicked.connect(self.add_new_route)
        btn_layout.addWidget(self.btn_add_route)
        self.btn_exit = QPushButton("خروج")
        self.btn_exit.setShortcut("Ctrl+Q")
        self.btn_exit.clicked.connect(self.close_app)
        btn_layout.addWidget(self.btn_exit)
        self.btn_close_all = QPushButton("بستن همه مسیرها")
        self.btn_close_all.setShortcut("Ctrl+W")
        self.btn_close_all.clicked.connect(self.close_all_routes)
        btn_layout.addWidget(self.btn_close_all)
        main_layout.addLayout(btn_layout)
        self.image_label = QLabel()
        self.image_label.setAlignment(Qt.AlignCenter)
        self.image_label.setScaledContents(True)
        image_path = resource_path("buttons_background.jpg")
        if os.path.exists(image_path):
            pixmap = QPixmap(image_path)
            self.image_label.setPixmap(pixmap)
        else:
            self.image_label.setText("تصویری برای نمایش یافت نشد!")
            self.image_label.setStyleSheet("color: gray; font-size: 14px;")
        self.image_label.setFixedHeight(200)
        main_layout.addWidget(self.image_label)
        self.routes_table = QTableWidget()
        self.routes_table.setRowCount(0)
        self.routes_table.setColumnCount(7)
        self.routes_table.setHorizontalHeaderLabels([
            "route_id", "مبدا", "مقصد", "تاریخ", "شماره قطار", "ظرفیت جستجو", "وضعیت"
        ])
        self.routes_table.setEditTriggers(QTableWidget.NoEditTriggers)
        self.routes_table.setSelectionBehavior(QTableWidget.SelectRows)
        self.routes_table.setSelectionMode(QTableWidget.SingleSelection)
        self.routes_table.horizontalHeader().setStretchLastSection(True)
        self.routes_table.verticalHeader().setVisible(False)
        self.routes_table.setStyleSheet("background-color: rgba(170, 170, 170, 100);")
        self.routes_table.itemDoubleClicked.connect(self.on_table_double_click)
        main_layout.addWidget(self.routes_table)
        self.setLayout(main_layout)

    def on_table_double_click(self, item):
        row = item.row()
        route_id_item = self.routes_table.item(row, 0)
        if not route_id_item:
            return
        try:
            route_id = int(route_id_item.text())
        except ValueError:
            QMessageBox.warning(self, "خطا", "شناسه مسیر نامعتبر است.")
            return
        if route_id in self.route_windows:
            win = self.route_windows[route_id]
            if not win.isVisible():
                win.show()
            win.raise_()
            win.activateWindow()
        else:
            QMessageBox.information(self, "اطلاعات", "این مسیر بسته شده یا وجود ندارد.")

    def close_app(self):
        self.save_state()
        for route_id, window in list(self.route_windows.items()):
            window.stop_search()
            window.close()
        if self.session:
            self.session.close()
        self.close()
        logging.info("برنامه بسته شد.")

    def add_new_route(self):
        max_routes = self.config.get("max_routes", 10)
        if self.route_count >= max_routes:
            QMessageBox.warning(self, "هشدار", f"حداکثر {max_routes} مسیر مجاز است.")
            return
        self.route_count += 1
        route_id = self.route_count
        row_index = self.routes_table.rowCount()
        self.routes_table.insertRow(row_index)
        self.routes_table.setItem(row_index, 0, QTableWidgetItem(str(route_id)))
        self.routes_table.setItem(row_index, 1, QTableWidgetItem(""))
        self.routes_table.setItem(row_index, 2, QTableWidgetItem(""))
        self.routes_table.setItem(row_index, 3, QTableWidgetItem(""))
        self.routes_table.setItem(row_index, 4, QTableWidgetItem(""))
        self.routes_table.setItem(row_index, 5, QTableWidgetItem(""))
        self.routes_table.setItem(row_index, 6, QTableWidgetItem("در انتظار جستجو"))
        route_window = RouteSearchWindow(self, route_id)
        self.route_windows[route_id] = route_window
        route_window.show()

    def remove_route_by_id(self, route_id):
        if route_id in self.route_windows:
            self.route_windows.pop(route_id)
            self.route_count -= 1
        if route_id in self.route_search_data:
            self.route_search_data.pop(route_id)
        for r in range(self.routes_table.rowCount()):
            rid_item = self.routes_table.item(r, 0)
            if rid_item and rid_item.text() == str(route_id):
                self.routes_table.removeRow(r)
                break

    def update_route_status(self, route_id, status_text):
        for r in range(self.routes_table.rowCount()):
            rid_item = self.routes_table.item(r, 0)
            if rid_item and rid_item.text() == str(route_id):
                self.routes_table.setItem(r, 6, QTableWidgetItem(status_text))
                route_data = self.route_search_data.get(route_id)
                if route_data is not None:
                    from_code = route_data.get("from", "")
                    to_code = route_data.get("to", "")
                    fromd = route_data.get("fromd", "")
                    train_num = route_data.get("departureTrain", "")
                    capacity_needed = route_data.get("passCnt", "")
                    from_city = [k for k, v in self.city_codes.items() if v == from_code]
                    to_city = [k for k, v in self.city_codes.items() if v == to_code]
                    if from_city:
                        self.routes_table.setItem(r, 1, QTableWidgetItem(from_city[0]))
                    if to_city:
                        self.routes_table.setItem(r, 2, QTableWidgetItem(to_city[0]))
                    self.routes_table.setItem(r, 3, QTableWidgetItem(fromd))
                    self.routes_table.setItem(r, 4, QTableWidgetItem(train_num))
                    self.routes_table.setItem(r, 5, QTableWidgetItem(str(capacity_needed)))
                break

    def transfer_cookies(self):
        domain = "safirrail.ir"
        try:
            cj = browser_cookie3.firefox(domain_name=domain)
            for c in cj:
                self.session.cookies.set(
                    c.name, c.value, domain=c.domain, path=c.path,
                    secure=c.secure, expires=c.expires
                )
            logging.info("کوکی‌ها منتقل شدند.")
        except Exception as e:
            QMessageBox.critical(self, "خطا", f"خطا در انتقال کوکی‌ها: {e}")

    def open_firefox_profile(self):
        profile_path = self.config.get("firefox_profile_path", "")
        firefox_exe = self.config.get("firefox_exe_path", "")
        if not (os.path.exists(profile_path) and os.path.exists(firefox_exe)):
            QMessageBox.warning(self, "هشدار", "مسیر پروفایل یا فایل اجرایی Firefox نامعتبر است.")
            return
        try:
            subprocess.Popen([firefox_exe, "-profile", profile_path, self.config["base_url"]])
            logging.info("Firefox باز شد.")
        except FileNotFoundError:
            QMessageBox.critical(self, "خطا", "فایل اجرایی Firefox یافت نشد.")
            return
        except Exception as e:
            QMessageBox.critical(self, "خطا", f"خطا در باز کردن Firefox: {e}")
            return
        QTimer.singleShot(2000, self.transfer_cookies)

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
            "firefox_exe_path": get_default_firefox_path(),
            "firefox_profile_path": r"C:\Users\pc\AppData\Roaming\Mozilla\Firefox\Profiles\zj4ctpkj.selenium_profile",
            "max_routes": 10,
            "rate_limit_base_interval": 0.5
        }
        for key, default_value in default_config.items():
            if isinstance(default_value, int):
                self.config[key] = self.settings.value(key, default_value, type=int)
            elif isinstance(default_value, float):
                self.config[key] = self.settings.value(key, default_value, type=float)
            else:
                self.config[key] = self.settings.value(key, default_value)

    def save_config(self):
        for key, value in self.config.items():
            self.settings.setValue(key, value)

    def load_cities(self):
        json_path = resource_path("cities.json")
        if os.path.exists(json_path):
            try:
                with open(json_path, "r", encoding="utf-8") as f:
                    data = json.load(f)
                if isinstance(data, dict):
                    self.city_codes = data
                else:
                    logging.error("فرمت فایل cities.json معتبر نیست.")
            except Exception as e:
                logging.error(f"خطا در لود شهرها: {e}")
        else:
            logging.error("فایل cities.json یافت نشد.")

    def save_state(self):
        state = {}
        state["routes"] = list(self.route_search_data.keys())
        for route_id, route_data in self.route_search_data.items():
            state[str(route_id)] = route_data
        self.settings.setValue("app_state", state)

    def load_state(self):
        state = self.settings.value("app_state", {})
        if state:
            routes = state.get("routes", [])
            for route_id in routes:
                try:
                    route_id_int = int(route_id)
                    self.route_count += 1
                    route_window = RouteSearchWindow(self, route_id_int)
                    self.route_windows[route_id_int] = route_window
                    route_data = state.get(str(route_id))
                    if route_data:
                        self.route_search_data[route_id_int] = route_data
                except ValueError:
                    logging.error(f"شناسه مسیر نامعتبر: {route_id}")

    def _send_request(self, url, data, method='post', headers=None, max_retries=5, backoff_factor=0.5):
        base_url = self.config["base_url"]
        default_headers = {
            "User-Agent": self.config.get("user_agent", ""),
            "Content-Type": self.config.get("content_type", "application/x-www-form-urlencoded"),
            "Accept": self.config.get("accept", "*/*"),
            "Referer": base_url + "/etrain/index.php",
            "Origin": base_url
        }
        if headers:
            default_headers.update(headers)
        attempt = 1
        while attempt <= max_retries:
            self.rate_limiter.wait_before_request()
            try:
                if method.lower() == 'post':
                    resp = self.session.post(url, data=data, headers=default_headers, verify=False)
                else:
                    resp = self.session.get(url, headers=default_headers, verify=False)
                resp.raise_for_status()
                return resp.text
            except requests.exceptions.RequestException as e:
                logging.error(f"خطا در ارسال درخواست (attempt {attempt}): {e}")
                if attempt < max_retries:
                    sleep_time = backoff_factor * (2 ** (attempt - 1))
                    logging.debug(f"انتظار {sleep_time} ثانیه قبل از تلاش مجدد...")
                    time.sleep(sleep_time)
                    attempt += 1
                else:
                    return None

    def _send_search_request(self, search_data):
        full_url = self.config["base_url"] + self.config["search_url"]
        logging.debug(f"داده‌های ارسالی: {search_data}")
        return self._send_request(full_url, search_data, 'post', max_retries=50, backoff_factor=0.5)

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
            "tmpDate": departure_date
        }
        return data

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
                a_match = re.search(r'(\d+)', avail_text)
                total_capacity = int(a_match.group(1)) if a_match else 0
                if total_capacity >= capacity_needed:
                    train_info = {
                        "شماره قطار": train_num,
                        "ساعت حرکت": time_text,
                        "قیمت": price_text,
                        "نوع کوپه": coupe_text,
                        "ظرفیت": total_capacity,
                        "srvc": srvc
                    }
                    results.append(train_info)
            except Exception as e:
                logging.error(f"خطا در استخراج قطار: {e}")
        return results

    def show_train_selection_window(self, available_trains, parent=None):
        dialog = TrainSelectionDialog(available_trains, parent=parent)
        res = dialog.exec_()
        return dialog.selected_train if res == QDialog.Accepted else None

    def prepare_passenger_data_for_paste(self, route_id):
        passenger_data_list = []
        table = self.route_windows[route_id].passengers_table
        for row_index in range(table.rowCount()):
            row_data = []
            for col in [1, 2, 3, 4, 5, 6]:
                widget = table.cellWidget(row_index, col)
                if isinstance(widget, QLineEdit):
                    row_data.append(widget.text())
                elif isinstance(widget, QSpinBox):
                    row_data.append(str(widget.value()).zfill(2))
                else:
                    row_data.append("")
            passenger_data_list.append(row_data)
        return passenger_data_list

    def switch_to_persian(self):
        pyautogui.hotkey("alt", "shift")
        time.sleep(0.5)

    def paste_data_to_form(self, passenger_data_list):
        time.sleep(2)
        windows = pyautogui.getWindowsWithTitle("Firefox")
        if windows:
            windows[0].activate()
        self.switch_to_persian()
        for data in passenger_data_list:
            for field in data:
                pyperclip.copy(field)
                pyautogui.hotkey("ctrl", "v")
                pyautogui.press('tab')
            pyautogui.press('tab')

    def perform_reservation(self, from_code, to_code, departure_date, gender,
                           passengers, train_number, srvc_value, selected_train, route_id):
        if not self.session:
            QMessageBox.critical(self, "خطا", "کوکی‌ها منتقل نشده‌اند.")
            logging.error("رزرو بدون کوکی‌ها.")
            return
        if not all([from_code, to_code, departure_date, gender, passengers, train_number, srvc_value]):
            QMessageBox.critical(self, "خطا", "اطلاعات رزرو ناقص است.")
            logging.error("رزرو با اطلاعات ناقص.")
            return
        logging.info(f"رزرو قطار {train_number} از {from_code} به {to_code} در {departure_date}.")
        route_data = self.route_search_data.get(route_id, {})
        adult = int(route_data.get("adult", 1))
        child = int(route_data.get("child", 0))
        infant = int(route_data.get("infant", 0))
        foreigner = int(route_data.get("forien", 0))
        gender_str = self.route_windows[route_id]._get_gender_string_from_radio()
        reserve_data = self._build_search_data(
            from_code, to_code, departure_date, gender_str, passengers,
            train_number, adult=adult, child=child, infant=infant, foreigner=foreigner
        )
        reserve_data["srvc"] = srvc_value
        logging.debug(f"داده‌های رزرو: {reserve_data}")
        form_html = '<html><head><meta charset="UTF-8"></head><body onload="document.forms[0].submit();">'
        form_html += f'<form action="{self.config["base_url"]}{self.config["reserve_url"]}" method="POST">'
        for key, value in reserve_data.items():
            escaped_value = value.replace('"', '&quot;') if isinstance(value, str) else value
            form_html += f'<input type="hidden" name="{key}" value="{escaped_value}"/>'
        form_html += '</form></body></html>'
        try:
            with tempfile.NamedTemporaryFile(delete=False, suffix=".html", mode='w', encoding="utf-8") as temp_file:
                temp_file.write(form_html)
                temp_form_path = temp_file.name
            logging.debug(f"فرم رزرو در {temp_form_path} ذخیره شد.")
        except Exception as e:
            QMessageBox.critical(self, "خطا", f"خطا در ایجاد فایل فرم رزرو: {e}")
            logging.error(f"خطا در ایجاد فایل: {e}")
            return
        try:
            profile_path = self.config.get("firefox_profile_path", "")
            firefox_exe = self.config.get("firefox_exe_path", "")
            file_url = f"file:///{temp_form_path}"
            subprocess.Popen([firefox_exe, "-profile", profile_path, file_url])
            logging.info(f"Firefox با پروفایل {profile_path} باز شد.")
        except FileNotFoundError:
            QMessageBox.critical(self, "خطا", "فایل اجرایی Firefox یافت نشد.")
            logging.error("فایل اجرایی Firefox یافت نشد.")
        except Exception as e:
            QMessageBox.critical(self, "خطا", f"خطا در باز کردن Firefox: {e}")
            logging.error(f"Error opening Firefox: {e}")
        passenger_data = self.prepare_passenger_data_for_paste(route_id)
        QTimer.singleShot(3000, lambda: self.paste_data_to_form(passenger_data))

    def close_all_routes(self):
        for route_id, window in list(self.route_windows.items()):
            window.stop_search()
            window.close()

class RouteSearchWindow(QDialog):
    def __init__(self, parent_app, route_id):
        super().__init__()
        self.parent_app = parent_app
        self.route_id = route_id
        self.worker = None
        self.setWindowFlags(Qt.Window | Qt.WindowMinMaxButtonsHint | Qt.WindowCloseButtonHint)
        self.setMinimumSize(650, 600)
        self.initUI()

    def initUI(self):
        layout = QVBoxLayout()
        self.info_label = QLabel("تنظیمات مسیر")
        self.info_label.setFont(QFont('Helvetica', 14, QFont.Bold))
        self.info_label.setAlignment(Qt.AlignCenter)
        layout.addWidget(self.info_label)
        form_layout = QGridLayout()
        form_layout.setSpacing(10)
        city_names = list(self.parent_app.city_codes.keys())
        form_layout.addWidget(QLabel("مبدا:"), 0, 0)
        self.entry_start = QComboBox()
        self.entry_start.addItems(city_names)
        if "تهران" in city_names:
            self.entry_start.setCurrentText("تهران")
        form_layout.addWidget(self.entry_start, 0, 1)
        form_layout.addWidget(QLabel("مقصد:"), 0, 2)
        self.entry_destination = QComboBox()
        self.entry_destination.addItems(city_names)
        if "مشهد" in city_names:
            self.entry_destination.setCurrentText("مشهد")
        form_layout.addWidget(self.entry_destination, 0, 3)
        form_layout.addWidget(QLabel("تاریخ (شمسی):"), 1, 0)
        self.entry_departure_date = QLineEdit()
        self.entry_departure_date.setReadOnly(False)
        form_layout.addWidget(self.entry_departure_date, 1, 1)
        btn_prev_day = QPushButton("روز قبل")
        btn_prev_day.clicked.connect(self.prev_day)
        form_layout.addWidget(btn_prev_day, 1, 2)
        btn_next_day = QPushButton("روز بعد")
        btn_next_day.clicked.connect(self.next_day)
        form_layout.addWidget(btn_next_day, 1, 3)
        form_layout.addWidget(QLabel("جنسیت:"), 2, 0)
        self.gender_group = QButtonGroup()
        self.radio_normal = QRadioButton("عادی")
        self.radio_normal.setChecked(True)
        self.gender_group.addButton(self.radio_normal)
        self.radio_brothers = QRadioButton("برادران")
        self.gender_group.addButton(self.radio_brothers)
        self.radio_sisters = QRadioButton("خواهران")
        self.gender_group.addButton(self.radio_sisters)
        gender_layout = QHBoxLayout()
        gender_layout.addWidget(self.radio_normal)
        gender_layout.addWidget(self.radio_brothers)
        gender_layout.addWidget(self.radio_sisters)
        form_layout.addLayout(gender_layout, 2, 1, 1, 3)
        form_layout.addWidget(QLabel("شماره قطار (اختیاری):"), 3, 0)
        self.entry_train_number = QLineEdit()
        form_layout.addWidget(self.entry_train_number, 3, 1, 1, 3)
        layout.addLayout(form_layout)
        self.passengers_table = QTableWidget()
        self.passengers_table.setColumnCount(7)
        self.passengers_table.setHorizontalHeaderLabels(["نوع سهمیه", "کد ملی", "روز تولد", "ماه تولد", "سال تولد", "نام", "نام خانوادگی"])
        layout.addWidget(self.passengers_table)
        btn_auto_fill = QPushButton("پر کردن خودکار فرم")
        btn_auto_fill.clicked.connect(self.trigger_auto_fill)
        layout.addWidget(btn_auto_fill)
        table_btn_layout = QHBoxLayout()
        btn_add_row = QPushButton("افزودن ردیف")
        btn_add_row.clicked.connect(self.add_passenger_row)
        table_btn_layout.addWidget(btn_add_row)
        btn_remove_row = QPushButton("حذف ردیف")
        btn_remove_row.clicked.connect(self.remove_passenger_row)
        table_btn_layout.addWidget(btn_remove_row)
        layout.addLayout(table_btn_layout)
        btn_layout = QHBoxLayout()
        self.btn_start = QPushButton("شروع جستجو")
        self.btn_start.setShortcut("Ctrl+S")
        self.btn_start.clicked.connect(self.start_search)
        btn_layout.addWidget(self.btn_start)
        self.btn_stop = QPushButton("لغو جستجو")
        self.btn_stop.setShortcut("Ctrl+X")
        self.btn_stop.clicked.connect(self.stop_search)
        self.btn_stop.setEnabled(False)
        btn_layout.addWidget(self.btn_stop)
        layout.addLayout(btn_layout)
        self.status_label = QLabel("")
        self.status_label.setAlignment(Qt.AlignCenter)
        layout.addWidget(self.status_label)
        self.search_progress_bar = QProgressBar()
        self.search_progress_bar.setRange(0, 0)
        self.search_progress_bar.setVisible(False)
        layout.addWidget(self.search_progress_bar)
        self.setLayout(layout)
        self.update_top_label()
        self.set_default_jalali_date()

    def trigger_auto_fill(self):
        passenger_data = self.parent_app.prepare_passenger_data_for_paste(self.route_id)
        self.parent_app.paste_data_to_form(passenger_data)

    def update_table_columns(self, row_index, quota_type):
        if quota_type == "اتباع":
            headers = ["نوع سهمیه", "شماره گذرنامه", "نام", "نام خانوادگی"]
            self.passengers_table.setColumnCount(len(headers))
            self.passengers_table.setHorizontalHeaderLabels(headers)
            quota_combo = self.passengers_table.cellWidget(row_index, 0)
            if not quota_combo:
                quota_combo = QComboBox()
                quota_combo.addItems(["بزرگسال", "خردسال", "کودک", "اتباع"])
                quota_combo.setCurrentText(quota_type)
                quota_combo.currentTextChanged.connect(lambda text, row=row_index: self.on_quota_type_changed(row, text))
                self.passengers_table.setCellWidget(row_index, 0, quota_combo)
            else:
                quota_combo.setCurrentText(quota_type)
            self.passengers_table.removeCellWidget(row_index, 1)
            self.passengers_table.setCellWidget(row_index, 1, QLineEdit())
            for col in [2, 3]:
                self.passengers_table.removeCellWidget(row_index, col)
                self.passengers_table.setCellWidget(row_index, col, QLineEdit())
        else:
            headers = ["نوع سهمیه", "کد ملی", "روز تولد", "ماه تولد", "سال تولد", "نام", "نام خانوادگی"]
            self.passengers_table.setColumnCount(len(headers))
            self.passengers_table.setHorizontalHeaderLabels(headers)
            quota_combo = self.passengers_table.cellWidget(row_index, 0)
            if not quota_combo:
                quota_combo = QComboBox()
                quota_combo.addItems(["بزرگسال", "خردسال", "کودک", "اتباع"])
                quota_combo.setCurrentText(quota_type)
                quota_combo.currentTextChanged.connect(lambda text, row=row_index: self.on_quota_type_changed(row, text))
                self.passengers_table.setCellWidget(row_index, 0, quota_combo)
            else:
                quota_combo.setCurrentText(quota_type)
            self.passengers_table.removeCellWidget(row_index, 1)
            self.passengers_table.setCellWidget(row_index, 1, QLineEdit())
            for col in [2,3,4]:
                self.passengers_table.removeCellWidget(row_index, col)
                spin = QSpinBox()
                spin.setRange(1, 31 if col == 2 else 12 if col == 3 else 1300)
                self.passengers_table.setCellWidget(row_index, col, spin)
            for col in [5, 6]:
                self.passengers_table.removeCellWidget(row_index, col)
                self.passengers_table.setCellWidget(row_index, col, QLineEdit())

    def add_passenger_row(self):
        row_index = self.passengers_table.rowCount()
        self.passengers_table.insertRow(row_index)
        quota_combo = QComboBox()
        quota_combo.addItems(["بزرگسال", "خردسال", "کودک", "اتباع"])
        quota_combo.setCurrentText("بزرگسال")
        quota_combo.currentTextChanged.connect(lambda text, row=row_index: self.on_quota_type_changed(row, text))
        self.passengers_table.setCellWidget(row_index, 0, quota_combo)
        national_code_edit = QLineEdit()
        national_code_edit.setPlaceholderText("کد ملی")
        self.passengers_table.setCellWidget(row_index, 1, national_code_edit)
        day_spin = QSpinBox()
        day_spin.setRange(1, 31)
        day_spin.setValue(1)
        self.passengers_table.setCellWidget(row_index, 2, day_spin)
        month_spin = QSpinBox()
        month_spin.setRange(1, 12)
        month_spin.setValue(1)
        self.passengers_table.setCellWidget(row_index, 3, month_spin)
        year_spin = QSpinBox()
        year_spin.setRange(1300, 1450)
        year_spin.setValue(1370)
        self.passengers_table.setCellWidget(row_index, 4, year_spin)
        name_edit = QLineEdit()
        name_edit.setPlaceholderText("نام")
        self.passengers_table.setCellWidget(row_index, 5, name_edit)
        family_name_edit = QLineEdit()
        family_name_edit.setPlaceholderText("نام خانوادگی")
        self.passengers_table.setCellWidget(row_index, 6, family_name_edit)
        self.passengers_table.setHorizontalHeaderLabels([
            "نوع سهمیه", "کد ملی", "روز تولد", "ماه تولد", "سال تولد", "نام", "نام خانوادگی"
        ])
        self.passengers_table.resizeColumnsToContents()

    def on_quota_type_changed(self, row_index, new_quota_type):
        self.update_table_columns(row_index, new_quota_type)
        print(f"DEBUG: ردیف {row_index} تغییر به {new_quota_type}")

    def remove_passenger_row(self):
        selected_rows = self.passengers_table.selectionModel().selectedRows()
        if not selected_rows:
            QMessageBox.warning(self, "هشدار", "لطفاً یک ردیف را انتخاب کنید.")
            return
        row_indices = sorted([row.row() for row in selected_rows], reverse=True)
        for index in row_indices:
            self.passengers_table.removeRow(index)

    def start_search(self):
        self.update_top_label()
        from_city_name = self.entry_start.currentText()
        to_city_name = self.entry_destination.currentText()
        from_code = self.parent_app.city_codes.get(from_city_name)
        to_code = self.parent_app.city_codes.get(to_city_name)
        jalali_date_str = self.entry_departure_date.text().strip()
        try:
            jalali_date = jdatetime.datetime.strptime(jalali_date_str, '%Y/%m/%d').date()
            gregorian_date_str = jalali_date_str
        except ValueError:
            self._set_status("فرمت تاریخ اشتباه است.", "red")
            return
        train_number = self.entry_train_number.text().strip()
        if self.radio_brothers.isChecked():
            gender_str = "برادران"
        elif self.radio_sisters.isChecked():
            gender_str = "خواهران"
        else:
            gender_str = "عادی"
        adult_count = 0
        child_count = 0
        infant_count = 0
        foreigner_count = 0
        for row in range(self.passengers_table.rowCount()):
            quota_combo = self.passengers_table.cellWidget(row, 0)
            quota_type = quota_combo.currentText()
            if quota_type == "بزرگسال":
                adult_count += 1
            elif quota_type == "خردسال":
                child_count += 1
            elif quota_type == "کودک":
                infant_count += 1
            elif quota_type == "اتباع":
                foreigner_count += 1
        passengers = adult_count + child_count + infant_count + foreigner_count
        if not (from_code and to_code and gregorian_date_str and passengers > 0):
            self._set_status("ورودی‌ها ناقص است", "red")
            return
        search_data = self.parent_app._build_search_data(
            from_code, to_code, gregorian_date_str,
            gender_str, passengers, train_number,
            adult=adult_count, child=child_count, infant=infant_count, foreigner=foreigner_count
        )
        self.parent_app.route_search_data[self.route_id] = search_data
        worker = Worker(self.parent_app, self.route_id, search_data)
        self.worker = worker
        worker.signals.finished.connect(self.on_search_finished)
        worker.signals.progress.connect(self.update_status)
        worker.signals.train_found.connect(self.show_train_selection)
        worker.signals.error_signal.connect(self.on_worker_error)
        self.parent_app.threadpool.start(worker)
        self.btn_start.setEnabled(False)
        self.btn_stop.setEnabled(True)
        self.search_progress_bar.setVisible(True)
        self._set_status("جستجو آغاز شد...", "blue")

    def _set_status(self, text, color="black"):
        self.status_label.setText(text)
        self.status_label.setStyleSheet(f"color: {color}; font-size:14px;")

    def update_top_label(self):
        from_c = self.entry_start.currentText()
        to_c = self.entry_destination.currentText()
        jalali_date = self.entry_departure_date.text()
        train_num = self.entry_train_number.text().strip()
        txt = f"{from_c} به {to_c} - تاریخ {jalali_date}"
        if train_num:
            txt += f" - قطار {train_num}"
        self.setWindowTitle(txt)

    def set_default_jalali_date(self):
        today_jalali = jdatetime.date.today()
        self.entry_departure_date.setText(today_jalali.strftime('%Y/%m/%d'))

    def prev_day(self):
        current_text = self.entry_departure_date.text().strip()
        try:
            jalali_date = jdatetime.datetime.strptime(current_text, '%Y/%m/%d').date()
            jalali_prev = jalali_date - timedelta(days=1)
            self.entry_departure_date.setText(jalali_prev.strftime('%Y/%m/%d'))
            self.update_top_label()
        except ValueError:
            QMessageBox.warning(self, "هشدار", "فرمت تاریخ اشتباه است.")

    def next_day(self):
        current_text = self.entry_departure_date.text().strip()
        try:
            jalali_date = jdatetime.datetime.strptime(current_text, '%Y/%m/%d').date()
            jalali_next = jalali_date + timedelta(days=1)
            self.entry_departure_date.setText(jalali_next.strftime('%Y/%m/%d'))
            self.update_top_label()
        except ValueError:
            QMessageBox.warning(self, "هشدار", "فرمت تاریخ اشتباه است.")

    def stop_search(self):
        self._set_status("توقف جستجو...", "red")
        self.parent_app.update_route_status(self.route_id, "جستجو متوقف شد")
        if self.worker:
            self.worker.stop()

    @pyqtSlot()
    def on_search_finished(self):
        self.btn_start.setEnabled(True)
        self.btn_stop.setEnabled(False)
        self.search_progress_bar.setVisible(False)
        self._set_status("جستجو متوقف شد", "red")
        self.parent_app.update_route_status(self.route_id, "جستجو متوقف شد")
        self.worker = None

    def update_status(self, msg, color):
        self._set_status(msg, color)
        self.parent_app.update_route_status(self.route_id, msg)

    @pyqtSlot(list)
    def show_train_selection(self, available_trains):
        route_data = self.parent_app.route_search_data.get(self.route_id, {})
        specific_train_number = route_data.get("departureTrain")
        if specific_train_number and available_trains:
            selected_train = available_trains[0]
            srvc_value = selected_train.get("srvc", "")
            if not srvc_value:
                QMessageBox.critical(self, "خطا", "پارامتر srvc خالی است.")
                self.on_search_finished()
                return
            passengers = int(route_data.get("passCnt", 1))
            self.parent_app.perform_reservation(
                from_code=route_data.get("from", ""),
                to_code=route_data.get("to", ""),
                departure_date=route_data.get("fromd", ""),
                gender=self._get_gender_string_from_radio(),
                passengers=passengers,
                train_number=selected_train["شماره قطار"],
                srvc_value=srvc_value,
                selected_train=selected_train,
                route_id=self.route_id
            )
            self.on_search_finished()
            return
        selected_train = self.parent_app.show_train_selection_window(available_trains, parent=self)
        if selected_train:
            srvc_value = selected_train.get("srvc", "")
            if not srvc_value:
                QMessageBox.critical(self, "خطا", "پارامتر srvc خالی است.")
                return
            route_data = self.parent_app.route_search_data.get(self.route_id, {})
            passengers = int(route_data.get("passCnt", 1))
            self.parent_app.perform_reservation(
                from_code=route_data.get("from", ""),
                to_code=route_data.get("to", ""),
                departure_date=route_data.get("fromd", ""),
                gender=self._get_gender_string_from_radio(),
                passengers=passengers,
                train_number=selected_train["شماره قطار"],
                srvc_value=srvc_value,
                selected_train=selected_train,
                route_id=self.route_id
            )
            self.on_search_finished()
        else:
            self.update_status("قطاری انتخاب نشد.", "orange")
            self.on_search_finished()

    @pyqtSlot(str)
    def on_worker_error(self, msg):
        QMessageBox.critical(self, "خطا", msg)
        self.update_status(msg, "red")

    def closeEvent(self, event):
        self.stop_search()
        self.parent_app.remove_route_by_id(self.route_id)
        super().closeEvent(event)

    def _get_gender_string_from_radio(self):
        if self.radio_brothers.isChecked():
            return "برادران"
        elif self.radio_sisters.isChecked():
            return "خواهران"
        else:
            return "عادی"


def main():
    """ اجرای برنامه با بررسی دوره آزمایشی """
    app = QApplication(sys.argv)

    # ایجاد نمونه `TrialManager`
    trial_manager = TrialManager()

    # بررسی دوره آزمایشی پس از ساخت `QApplication`
    check_trial(trial_manager)

    # اجرای برنامه اصلی
    window = TrainReservationApp()
    window.show()
    
    sys.exit(app.exec_())

if __name__ == "__main__":
    main()
