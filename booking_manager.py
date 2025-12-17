import streamlit as st
import pandas as pd
from datetime import datetime, timedelta
import calendar
from db_handler import db

# 09:00 ~ 19:30
TIME_SLOTS = [
    "09:00", "09:30", "10:00", "10:30", "11:00", "11:30",
    "12:00", "12:30", "13:00", "13:30", "14:00", "14:30",
    "15:00", "15:30", "16:00", "16:30", "17:00", "17:30",
    "18:00", "18:30", "19:00", "19:30"
]

def load_css():
    with open("style.css", encoding="utf-8") as f:
        st.markdown(f"<style>{f.read()}</style>", unsafe_allow_html=True)

def render_booking_page(user, is_admin=False):
    load_css()
    
    title = "📅 예약 관리 (관리자)" if is_admin else "📅 예약하기"
    st.header(title)
    
    # --- Calendar Navigation State ---
    if 'cal_year' not in st.session_state:
        st.session_state.cal_year = datetime.now().year
        st.session_state.cal_month = datetime.now().month
    if 'selected_date' not in st.session_state:
        st.session_state.selected_date = None

    # --- Month Navigation UI ---
    col_prev, col_curr, col_next = st.columns([1, 5, 1])
    with col_prev:
        if st.button("◀이전"):
            st.session_state.cal_month -= 1
            if st.session_state.cal_month == 0:
                st.session_state.cal_year -= 1
                st.session_state.cal_month = 12
            st.rerun()
    with col_curr:
        st.markdown(f"<h3 style='text-align: center; color: #D2691E;'>{st.session_state.cal_year}년 {st.session_state.cal_month}월</h3>", unsafe_allow_html=True)
    with col_next:
        if st.button("다음▶"):
            st.session_state.cal_month += 1
            if st.session_state.cal_month == 13:
                st.session_state.cal_year += 1
                st.session_state.cal_month = 1
            st.rerun()

    # --- Draw Calendar Grid ---
    cols = st.columns(7)
    days_ko = ['일', '월', '화', '수', '목', '금', '토']
    
    # Hide Sunday Header? User said "Hide Sunday". 
    # But usually Calendar structure needs 7 cols. We will just leave Sunday column blank.
    for i, day in enumerate(days_ko):
        if i == 0: 
            cols[i].write("") # Hide Sunday Label
        else:
            color = "#4A4A4A"
            cols[i].markdown(f"<p style='text-align: center; color: {color}; font-weight: bold;'>{day}</p>", unsafe_allow_html=True)

    cal_obj = calendar.Calendar(firstweekday=6) 
    month_days = cal_obj.monthdayscalendar(st.session_state.cal_year, st.session_state.cal_month)
    today = datetime.now().date()
    
    for week in month_days:
        cols = st.columns(7)
        for i, day in enumerate(week):
            # i=0 is Sunday. Hide content.
            if i == 0 or day == 0:
                cols[i].write("") 
                continue
            
            current_date_obj = datetime(st.session_state.cal_year, st.session_state.cal_month, day).date()
            date_str = current_date_obj.strftime("%Y-%m-%d")
            
            # Simple Label: Just Day Number
            label = f"{day}일"
            is_past = current_date_obj < today
            
            if is_past and not is_admin: 
                cols[i].button(f"{label}", key=f"d_{date_str}", disabled=True, use_container_width=True)
            else:
                # Highlight selected date
                type_ = "primary" if st.session_state.selected_date == date_str else "secondary"
                if cols[i].button(f"{label}", key=f"d_{date_str}", type=type_, use_container_width=True):
                    st.session_state.selected_date = date_str
                    st.rerun()

    # --- Time Slot View ---
    if st.session_state.selected_date:
        st.divider()
        render_time_slots(st.session_state.selected_date, user, is_admin)

def render_time_slots(date_str, user, is_admin):
    st.subheader(f"🕒 {date_str} 예약 현황")
    
    todays_bookings = db.get_bookings(date_str)
    booking_map = {}
    if not todays_bookings.empty:
        for idx, row in todays_bookings.iterrows():
            booking_map[row['Time']] = row
    
    # --- 3 Column Layout (Updated Ranges) ---
    # Left: 09:00 - 12:30
    # Center: 13:00 - 16:30 (Moved 17:00 to Right)
    # Right: 17:00 - 19:30
    
    slots_left   = [t for t in TIME_SLOTS if "09:00" <= t <= "12:30"]
    slots_center = [t for t in TIME_SLOTS if "13:00" <= t <= "16:30"]
    slots_right  = [t for t in TIME_SLOTS if "17:00" <= t <= "19:30"]
    
    col_l, col_c, col_r = st.columns(3)
    
    def render_slot_group(col, title, slots):
        with col:
            st.markdown(f"**{title}**")
            for time in slots:
                booking_info = booking_map.get(time)
                
                # [Scenario 1] Booked Slot
                if booking_info is not None:
                    customer_name = booking_info['CustomerName']
                    phone = booking_info['Phone']
                    
                    # Safe check for user keys
                    is_my_booking = False
                    if user and 'Name' in user and 'Phone' in user:
                        is_my_booking = (customer_name == user['Name'] and phone == user['Phone'])
                    
                    if is_admin:
                        # Admin: Can Edit/Cancel ANY booking
                        if st.button(f"🔴 {time} ({customer_name})", key=f"adm_{time}", use_container_width=True):
                            booking_action_dialog(date_str, time, user, mode='edit', booking_data=booking_info, is_admin=True)
                    elif is_my_booking:
                        # User: Can Edit/Cancel OWN booking
                        if st.button(f"✅ {time}", key=f"my_{time}", type="primary", use_container_width=True):
                            booking_action_dialog(date_str, time, user, mode='edit', booking_data=booking_info, is_admin=False)
                    else:
                        # User: Someone else's booking
                        st.button(f"🚫 {time}", key=f"th_{time}", disabled=True, use_container_width=True)
                        
                # [Scenario 2] Empty Slot
                else:
                    if is_admin:
                        # Admin: Manual Add
                         if st.button(f"⚪ {time}", key=f"adm_new_{time}", use_container_width=True):
                            booking_action_dialog(date_str, time, user, mode='new', is_admin=True)
                    else:
                        # User: Book New
                        if st.button(f"🟦 {time}", key=f"usr_new_{time}", type="primary", use_container_width=True):
                             booking_action_dialog(date_str, time, user, mode='new', is_admin=False)

    render_slot_group(col_l, "오전 (09:00~12:30)", slots_left)
    render_slot_group(col_c, "오후1 (13:00~16:30)", slots_center)
    render_slot_group(col_r, "오후2 (17:00~19:30)", slots_right)

@st.dialog("예약 관리")
def booking_action_dialog(date, time, user, mode='new', booking_data=None, is_admin=False):
    # Mode: 'new' (Create), 'edit' (Update/Cancel)
    
    st.write(f"📅 **{date} {time}**")
    
    # Defaults
    default_name = user['Name'] if user else ""
    default_phone = user['Phone'] if user else ""
    default_memo = ""
    
    if mode == 'edit' and booking_data is not None:
        default_name = booking_data['CustomerName']
        default_phone = booking_data['Phone']
        default_memo = booking_data['Memo']
        st.info("기존 예약 내용을 수정하거나 취소할 수 있습니다.")
    else:
        st.info("새로운 예약을 진행합니다.")

    # --- Rescheduling Input (Date/Time Change) ---
    new_date_obj = datetime.strptime(date, "%Y-%m-%d").date()
    new_time = time
    
    if mode == 'edit' and is_admin:
        st.write("---")
        st.caption("일정 변경 (날짜/시간)")
        c1, c2 = st.columns(2)
        with c1:
            new_date_val = st.date_input("날짜 변경", value=new_date_obj)
            new_date_str = new_date_val.strftime("%Y-%m-%d")
        with c2:
            # Filter available times
            # Get bookings for selected new_date
            bookings_on_new_date = db.get_bookings(new_date_str)
            booked_times = bookings_on_new_date['Time'].tolist()
            
            # If staying on same date, exclude current time from 'booked' list so we can accept keeping it
            if new_date_str == date and time in booked_times:
                booked_times.remove(time)
                
            # Create list of Available Slots
            # If user wants to see 'Unavailable' items disabled, selectbox doesn't support it well.
            # We will filter the list to ONLY show available slots + Current Selection.
            
            available_slots = [t for t in TIME_SLOTS if t not in booked_times]
            
            # Ensure current selection is in list (if e.g. date changed)
            if time not in available_slots and new_date_str == date:
                 available_slots.append(time)
                 available_slots.sort()
            
            # If no slots, show warning
            if not available_slots:
                st.warning("예약 가능한 시간이 없습니다.")
                new_time = None
            else:
                try:
                    # Default to current time if available, otherwise first
                    default_idx = available_slots.index(time) if time in available_slots else 0
                except:
                    default_idx = 0
                new_time = st.selectbox("시간 변경", available_slots, index=default_idx)
        st.write("---")
    else:
        new_date_str = date
        new_time = time

    # --- Info Input ---
    # Fix: User Mode bug (Assign target_name before use)
    if is_admin:
        target_name = st.text_input("고객 이름", value=default_name)
        target_phone = st.text_input("고객 전화번호", value=default_phone)
    else:
        target_name = default_name
        target_phone = default_phone
        st.write(f"예약자: **{target_name}**")
        
    target_memo = st.text_input("요청사항 (메모)", value=default_memo)
    
    # Action Buttons
    col_save, col_cancel = st.columns(2)
    
    with col_save:
        btn_text = "예약 수정" if mode == 'edit' else "예약 하기"
        if st.button(btn_text, type="primary", use_container_width=True):
            if mode == 'edit':
                # Update with potential date/time change
                success, msg = db.update_booking(date, time, new_date_str, new_time, target_name, target_phone, target_memo)
            else:
                success, msg = db.add_booking(date, time, target_name, target_phone, target_memo)
            
            if success:
                st.success(msg)
                st.rerun()
            else:
                st.error(msg)
                
    with col_cancel:
        if mode == 'edit':
            if st.button("예약 취소", type="secondary", use_container_width=True):
                db.delete_booking(date, time)
                st.warning("예약이 취소되었습니다.")
                st.rerun()
        else:
             if st.button("닫기", use_container_width=True):
                 st.rerun()
