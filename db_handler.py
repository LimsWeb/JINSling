import pandas as pd
from datetime import datetime

# ==========================================
# MOCK DATABASE (개발용 가짜 데이터베이스)
# ==========================================
# 실제 구글 시트 연결 전, 로컬에서 로직을 테스트하기 위한 
# 가짜(Mock) 데이터 클래스입니다.
# 나중에 real GSpread connection으로 교체하면 됩니다.
# ==========================================

class MockGoogleSheetDB:
    def __init__(self):
        # 1. Users Sheet Simulation
        # Columns: Name, Phone, Password, Role, Status, JoinDate
        # In real Google Sheets, add a "Password" column.
        self.users_df = pd.DataFrame([
            {"Name": "admin", "Phone": "0000", "Password": "0000", "Role": "admin", "Status": "approved", "JoinDate": "2024-01-01"},
            {"Name": "테스트손님", "Phone": "1234", "Password": "1234", "Role": "user", "Status": "approved", "JoinDate": "2024-01-02"},
        ])
        
        # 2. Bookings Sheet Simulation
        self.bookings_df = pd.DataFrame([
            {"Date": datetime.now().strftime("%Y-%m-%d"), "Time": "10:00", "CustomerName": "테스트손님", "Memo": "첫방문", "Phone": "1234"}
        ])

    # --- User Functions ---
    def get_user(self, name, password):
        """Find a user by Name and Password"""
        # Note: In real app, hash the password!
        user = self.users_df[
            (self.users_df["Name"] == name) & 
            (self.users_df["Password"] == password)
        ]
        if not user.empty:
            return user.iloc[0].to_dict()
        return None

    def register_user(self, name, phone):
        """Register a new pending user"""
        if not self.users_df[(self.users_df["Name"] == name) & (self.users_df["Phone"] == phone)].empty:
            return False, "이미 존재하는 사용자입니다."
        
        new_user = {
            "Name": name, "Phone": phone, "Password": phone, # Initial PW is Phone
            "Role": "user", "Status": "pending", 
            "JoinDate": datetime.now().strftime("%Y-%m-%d")
        }
        self.users_df = pd.concat([self.users_df, pd.DataFrame([new_user])], ignore_index=True)
        return True, "가입 신청이 완료되었습니다. 관리자 승인을 기다려주세요."

    def change_password(self, name, phone, new_pw):
        """Change user password"""
        idx = self.users_df.index[
            (self.users_df["Name"] == name) & (self.users_df["Phone"] == phone)
        ].tolist()
        
        if idx:
            self.users_df.at[idx[0], "Password"] = new_pw
            return True, "비밀번호가 변경되었습니다."
        return False, "사용자를 찾을 수 없습니다."

    def reset_password(self, name, phone):
        """Reset password to phone number"""
        idx = self.users_df.index[
            (self.users_df["Name"] == name) & (self.users_df["Phone"] == phone)
        ].tolist()
        
        if idx:
            self.users_df.at[idx[0], "Password"] = phone
            return True, "비밀번호가 초기화되었습니다. (초기비밀번호: 전화번호)"
        return False, "일치하는 정보를 찾을 수 없습니다."

    # --- Booking Functions ---
    def get_bookings(self, date_str):
        """Get bookings for a specific date"""
        return self.bookings_df[self.bookings_df["Date"] == date_str]

    def add_booking(self, date, time, name, phone, memo):
        """Add a new booking"""
        # Check if slot is taken
        if not self.bookings_df[
            (self.bookings_df["Date"] == date) & (self.bookings_df["Time"] == time)
        ].empty:
            return False, "이미 예약된 시간입니다."
            
        new_booking = {
            "Date": date, "Time": time, 
            "CustomerName": name, "Phone": phone, "Memo": memo
        }
        self.bookings_df = pd.concat([self.bookings_df, pd.DataFrame([new_booking])], ignore_index=True)
        return True, "예약되었습니다."

    def update_booking(self, old_date, old_time, new_date, new_time, name, phone, memo):
        """Update an existing booking (including Date/Time change)"""
        
        # 1. booking existence check
        existing = self.bookings_df[
            (self.bookings_df["Date"] == old_date) & (self.bookings_df["Time"] == old_time)
        ]
        if existing.empty:
            return False, "원본 예약을 찾을 수 없습니다."
        
        # 2. If Date or Time changed, check availability of new slot
        if old_date != new_date or old_time != new_time:
            target_slot = self.bookings_df[
                (self.bookings_df["Date"] == new_date) & (self.bookings_df["Time"] == new_time)
            ]
            if not target_slot.empty:
                return False, "변경하려는 시간에 이미 예약이 있습니다."
                
            # Move: Delete Old & Add New
            self.delete_booking(old_date, old_time)
            # Add New (We use internal logic to bypass checks since we just checked)
            new_booking = {
                "Date": new_date, "Time": new_time, 
                "CustomerName": name, "Phone": phone, "Memo": memo
            }
            self.bookings_df = pd.concat([self.bookings_df, pd.DataFrame([new_booking])], ignore_index=True)
            return True, "예약이 이동되었습니다."
            
        else:
            # Just update info
            idx = existing.index[0]
            self.bookings_df.at[idx, "CustomerName"] = name
            self.bookings_df.at[idx, "Phone"] = phone
            self.bookings_df.at[idx, "Memo"] = memo
            return True, "예약 정보가 수정되었습니다."

    def delete_booking(self, date, time):
        """Delete a booking"""
        initial_len = len(self.bookings_df)
        self.bookings_df = self.bookings_df.drop(
            self.bookings_df[
                (self.bookings_df["Date"] == date) & (self.bookings_df["Time"] == time)
            ].index
        )
        if len(self.bookings_df) < initial_len:
            return True
        return False

# Singleton Instance (앱 내에서 공유)
# Streamlit은 매번 Rerun하므로 Session State에 저장해야 하지만, 
# 파일 레벨에서 먼저 인스턴스를 선언해둡니다.
db = MockGoogleSheetDB()
