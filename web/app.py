# -*- coding: utf-8 -*-
"""
BilitFast — نسخه تحت وب.

تبدیل برنامه دسکتاپی PyQt5 به یک وب‌اپ Flask با حفظ منطق اصلی.
منطق اصلی در web/core.py قرار دارد.
"""

import os
import logging
from datetime import datetime

from flask import (
    Flask, render_template, request, jsonify, session, redirect,
    url_for, Response, abort
)

from core import (
    ReservationEngine, TrialManager, BASE_DIR,
)

# ---------------------------------------------------------------------------
# تنظیمات لاگینگ
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=logging.DEBUG,
    format="%(asctime)s:%(levelname)s:%(message)s",
    handlers=[
        logging.FileHandler(os.path.join(BASE_DIR, "train_reservation.log"), encoding="utf-8"),
        logging.StreamHandler(),
    ],
)
logger = logging.getLogger("bilitfast")

app = Flask(__name__)
app.secret_key = os.environ.get("SECRET_KEY", "bilitfast-secret-key-change-me")

engine = ReservationEngine()
trial_manager = TrialManager()


# ---------------------------------------------------------------------------
# کنترل دوره آزمایشی
# ---------------------------------------------------------------------------
def trial_gate():
    """وضعیت دوره آزمایشی برای نمایش در UI."""
    if trial_manager.activated:
        return {"state": "activated", "message": "فعال‌سازی دائمی"}
    if trial_manager.start_date is None:
        return {"state": "not_started", "message": "دوره آزمایشی شروع نشده"}
    if trial_manager.trial_expired():
        return {"state": "expired", "message": "دوره آزمایشی به پایان رسیده"}
    return {"state": "active", "message": "دوره آزمایشی فعال"}


# ---------------------------------------------------------------------------
# صفحات
# ---------------------------------------------------------------------------
@app.route("/")
def index():
    if trial_manager.trial_expired():
        return redirect(url_for("trial_page"))
    return render_template("index.html", trial=trial_gate())


@app.route("/trial", methods=["GET", "POST"])
def trial_page():
    if request.method == "POST":
        action = request.form.get("action")
        if action == "start":
            trial_manager.start_trial()
            return redirect(url_for("index"))
        elif action == "activate":
            code = request.form.get("code", "")
            if code == TrialManager.ACTIVATION_CODE:
                trial_manager.activate_permanently()
                return render_template(
                    "trial.html", trial=trial_gate(),
                    message="✅ برنامه به صورت دائمی فعال شد.", error=False,
                )
            return render_template(
                "trial.html", trial=trial_gate(),
                message="❌ کد فعال‌سازی نادرست است.", error=True,
            )
    return render_template("trial.html", trial=trial_gate(), message=None, error=False)


@app.route("/route/<int:route_id>")
def route_page(route_id):
    if trial_manager.trial_expired():
        return redirect(url_for("trial_page"))
    if route_id not in engine.route_search_data and route_id not in engine.route_fields:
        abort(404)
    cities = list(engine.city_codes.keys())
    return render_template(
        "route.html",
        route_id=route_id,
        cities=cities,
        fields=engine.route_fields.get(route_id, {}),
        passengers=engine.route_passengers.get(route_id, []),
    )


@app.route("/login", methods=["GET", "POST"])
def login_page():
    if request.method == "POST":
        username = request.form.get("username", "")
        password = request.form.get("password", "")
        ok, message = engine.login(username, password)
        session["logged_in"] = ok
        return render_template("login.html", message=message, logged_in=ok)
    return render_template("login.html", message=None, logged_in=session.get("logged_in", False))


@app.route("/settings", methods=["GET", "POST"])
def settings_page():
    if request.method == "POST":
        # تنها بخش‌هایی که در وب معنا دارند ویرایش می‌شوند
        for key in [
            "refresh_interval", "max_routes", "rate_limit_base_interval",
            "login_url", "login_action", "login_user_field", "login_pass_field",
            "login_success_marker",
        ]:
            val = request.form.get(key)
            if val is not None:
                if key in ("refresh_interval", "max_routes", "rate_limit_base_interval"):
                    try:
                        engine.config[key] = float(val) if key == "rate_limit_base_interval" else int(val)
                    except ValueError:
                        pass
                else:
                    engine.config[key] = val.strip()
        engine.save_config()
        return redirect(url_for("settings_page"))
    return render_template("settings.html", config=engine.config)


# ---------------------------------------------------------------------------
# API
# ---------------------------------------------------------------------------
@app.route("/api/trial")
def api_trial():
    return jsonify(trial_gate())


@app.route("/api/routes", methods=["GET", "POST"])
def api_routes():
    if request.method == "POST":
        route_id, err = engine.add_route()
        if err:
            return jsonify({"error": err}), 400
        return jsonify({"route_id": route_id})
    routes = [engine.route_summary(rid) for rid in sorted(engine.route_search_data.keys() | engine.route_fields.keys())]
    return jsonify(routes)


@app.route("/api/routes/<int:route_id>", methods=["DELETE"])
def api_delete_route(route_id):
    engine.remove_route(route_id)
    return jsonify({"ok": True})


@app.route("/api/routes/<int:route_id>/start", methods=["POST"])
def api_start_search(route_id):
    payload = request.get_json(silent=True) or {}
    fields = payload.get("fields", {})
    passengers = payload.get("passengers", [])
    ok, message = engine.start_search(route_id, fields, passengers)
    if not ok:
        return jsonify({"error": message}), 400
    return jsonify({"ok": True, "message": message})


@app.route("/api/routes/<int:route_id>/stop", methods=["POST"])
def api_stop_search(route_id):
    engine.stop_search(route_id)
    return jsonify({"ok": True})


@app.route("/api/routes/<int:route_id>")
def api_route_detail(route_id):
    summary = engine.route_summary(route_id)
    summary["found_trains"] = engine.route_found_trains.get(route_id, [])
    summary["fields"] = engine.route_fields.get(route_id, {})
    return jsonify(summary)


@app.route("/api/routes/<int:route_id>/reserve", methods=["POST"])
def api_reserve(route_id):
    payload = request.get_json(silent=True) or {}
    train_number = payload.get("train_number")
    found = engine.route_found_trains.get(route_id, [])
    selected = None
    for t in found:
        if t.get("شماره قطار") == train_number:
            selected = t
            break
    if selected is None:
        return jsonify({"error": "قطار انتخابی یافت نشد."}), 404

    ok, result, reserve_data = engine.perform_reservation(route_id, selected)
    if not ok:
        return jsonify({"error": result}), 400

    passengers = engine.passenger_rows(route_id)
    # ذخیره فرم برای دانلود
    engine._last_reserve_html = result
    return jsonify({
        "ok": True,
        "form_html": result,
        "reserve_data": reserve_data,
        "passengers": passengers,
        "download_url": url_for("api_reserve_download", route_id=route_id),
    })


@app.route("/api/routes/<int:route_id>/reserve/download")
def api_reserve_download(route_id):
    form_html = getattr(engine, "_last_reserve_html", None)
    if not form_html:
        abort(404)
    return Response(
        form_html,
        mimetype="text/html",
        headers={"Content-Disposition": "attachment; filename=reservation_form.html"},
    )


@app.route("/api/state")
def api_state():
    routes = [engine.route_summary(rid) for rid in sorted(engine.route_search_data.keys() | engine.route_fields.keys())]
    return jsonify({
        "trial": trial_gate(),
        "logged_in": session.get("logged_in", False),
        "routes": routes,
    })


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=True)
