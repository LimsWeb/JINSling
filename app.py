import streamlit as st
import auth
from db_handler import db
from datetime import datetime

# Page Config
st.set_page_config(
    page_title="마사지 예약 시스템",
    page_icon="💆",
    layout="centered"
)

# Initialize Session State
if 'user' not in st.session_state:
    st.session_state['user'] = None

def main():
    st.title("💆 프라이빗 마사지 예약")
    
    # --- Authentication Flow ---
    if st.session_state['user'] is None:
        tab1, tab2 = st.tabs(["로그인", "회원가입"])
        with tab1:
            auth.login_form()
        with tab2:
            auth.register_form()
        return

    # --- Logged In View ---
    user = st.session_state['user']
    
    # Sidebar
    with st.sidebar:
        st.write(f"접속자: **{user['Name']}** ({user['Role']})")
        
        # Change Password Widget
        # Change Password Widget
        try:
            if hasattr(auth, 'change_password_form'):
                auth.change_password_form(user)
            else:
                # Fallback if module is stale
                import importlib
                importlib.reload(auth)
                if hasattr(auth, 'change_password_form'):
                    auth.change_password_form(user)
        except Exception as e:
            st.error(f"메뉴 로딩 오류: {e}")
        
        if st.button("로그아웃"):
            if 'selected_date' in st.session_state:
                del st.session_state['selected_date'] # Clear Date selection
            auth.logout()

    # --- Admin View ---
    if user['Role'] == 'admin':
        admin_dashboard()
    else:
        user_dashboard()

def admin_dashboard():
    st.header("관리자 페이지")
    
    tab1, tab2 = st.tabs(["예약 관리", "회원 승인 관리"])
    
    with tab1:
        # Re-use the Booking Page Logic for Admin
        # Pass is_admin=True to show Cancel/Manual Book options
        import booking_manager
        import importlib
        importlib.reload(booking_manager)
        booking_manager.render_booking_page(st.session_state['user'], is_admin=True)
        
    with tab2:
        st.subheader("가입 대기 목록")
        pending_users = db.get_pending_users()
        
        if pending_users.empty:
            st.write("대기 중인 회원이 없습니다.")
        else:
            for index, row in pending_users.iterrows():
                col1, col2, col3, col4 = st.columns([2, 3, 2, 2])
                with col1:
                    st.write(f"**{row['Name']}**")
                with col2:
                    st.write(row['Phone'])
                with col3:
                    if st.button("승인(Accept)", key=f"approve_{index}"):
                        db.approve_user(row['Name'], row['Phone'])
                        st.success(f"{row['Name']}님을 승인했습니다.")
                        st.rerun()
                with col4:
                    if st.button("거절(Reject)", key=f"reject_{index}"):
                        db.reject_user(row['Name'], row['Phone'])
                        st.warning(f"{row['Name']}님을 삭제했습니다.")
                        st.rerun()

def user_dashboard():
    # Load Booking Interface
    import booking_manager
    user = st.session_state['user']
    import importlib
    importlib.reload(booking_manager)
    
    tab1, tab2 = st.tabs(["예약 하기", "나의 예약 현황"])
    
    with tab1:
        booking_manager.render_booking_page(user)
        
    with tab2:
        st.subheader(f"{user['Name']}님의 예약 내역")
        # Filter bookings for this user
        # In real DB we would query by Name/Phone.
        # Here we filter the dataframe.
        my_bookings = db.bookings_df[
            (db.bookings_df['CustomerName'] == user['Name']) &
            (db.bookings_df['Phone'] == user['Phone'])
        ]
        
        if my_bookings.empty:
            st.info("예약 내역이 없습니다.")
        else:
            for idx, row in my_bookings.iterrows():
                with st.container():
                    c1, c2, c3 = st.columns([3, 2, 2])
                    c1.write(f"📅 **{row['Date']}** {row['Time']}")
                    c2.write(f"📝 {row['Memo']}")
                    with c3:
                        if st.button("취소하기", key=f"my_cncl_{idx}"):
                            db.delete_booking(row['Date'], row['Time'])
                            st.success("취소되었습니다.")
                            st.rerun()
                    st.divider()

if __name__ == "__main__":
    main()
