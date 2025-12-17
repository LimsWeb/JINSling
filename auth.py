import streamlit as st
from db_handler import db

def login_form():
    """Handles Login Logic"""
    st.subheader("로그인")
    
    with st.form("login_form"):
        name = st.text_input("이름 (ID)", placeholder="예: 홍길동")
        password = st.text_input("비밀번호", placeholder="초기비밀번호: 전화번호", type="password")
        submitted = st.form_submit_button("로그인")
        
        if submitted:
            user = db.get_user(name, password)
            if user:
                if user['Status'] == 'approved':
                    st.session_state['user'] = user
                    st.success(f"{name}님 환영합니다!")
                    st.rerun()
                elif user['Status'] == 'pending':
                    st.warning("가입 대기 중입니다. 관리자 승인을 기다려주세요.")
                else:
                    st.error("알 수 없는 오류가 발생했습니다.")
            else:
                st.error("정보가 일치하지 않거나 존재하지 않는 사용자입니다.")
    
    # Forgot Password Expander
    with st.expander("비밀번호를 잊으셨나요? (초기화)"):
        with st.form("reset_pw_form"):
            st.write("이름과 전화번호가 일치하면 비밀번호를 전화번호로 초기화합니다.")
            r_name = st.text_input("이름")
            r_phone = st.text_input("전화번호")
            r_submitted = st.form_submit_button("비밀번호 초기화")
            
            if r_submitted:
                success, msg = db.reset_password(r_name, r_phone)
                if success:
                    st.success(msg)
                else:
                    st.error(msg)

def change_password_form(user):
    with st.expander("비밀번호 변경"):
        with st.form("change_pw_form"):
            new_pw = st.text_input("새로운 비밀번호", type="password")
            confirm_pw = st.text_input("비밀번호 확인", type="password")
            submitted = st.form_submit_button("변경하기")
            
            if submitted:
                if new_pw != confirm_pw:
                    st.error("비밀번호가 일치하지 않습니다.")
                elif len(new_pw) < 4:
                    st.error("비밀번호는 4자리 이상이어야 합니다.")
                else:
                    success, msg = db.change_password(user['Name'], user['Phone'], new_pw)
                    if success:
                        st.success(msg)
                        # Update session state with new user info (if needed) but essentially logic works
                    else:
                        st.error(msg)

def register_form():
    """Handles Registration Logic"""
    st.subheader("회원가입")
    
    with st.form("reg_form"):
        name = st.text_input("이름", placeholder="한글 실명")
        phone = st.text_input("전화번호", placeholder="예: 01012345678 (하이픈 제외)")
        submitted = st.form_submit_button("가입 신청")
        
        if submitted:
            if name and phone:
                success, msg = db.register_user(name, phone)
                if success:
                    st.success(msg)
                else:
                    st.error(msg)
            else:
                st.error("이름과 전화번호를 모두 입력해주세요.")

def logout():
    if 'user' in st.session_state:
        del st.session_state['user']
    st.rerun()
