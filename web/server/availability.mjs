import {addDays,fail,time,validDate} from './support.mjs';

// One calendar request is always one real month, never a caller-sized range.
export function calendarMonthDates(month) {
  if(typeof month!=='string'||!/^\d{4}-(0[1-9]|1[0-2])$/.test(month))fail(400,'invalid_input','조회할 월을 확인해 주세요.');
  const first=validDate(`${month}-01`),end=new Date(`${first}T00:00:00Z`);
  end.setUTCMonth(end.getUTCMonth()+1);end.setUTCDate(0);
  return Array.from({length:end.getUTCDate()},(_,index)=>`${month}-${String(index+1).padStart(2,'0')}`);
}

// Only anonymous intervals enter this projection. Both calendar summaries and
// the selected day's buttons use it, with one captured Seoul time per response.
export function dayAvailability({date,rule,bookings,blocks,settings,now}) {
  const currentDate=now.slice(0,10),outside=date<currentDate||date>addDays(currentDate,settings.booking_window_days);
  const closed=outside||!rule||!!rule.closed,atCapacity=bookings.length>=(rule?.daily_limit??0),slots=[];
  const overlaps=(intervals,start)=>intervals.some(interval=>interval.start_min<start+30&&interval.end_min>start);
  if(!closed)for(let start=rule.open_min;start+30<=rule.close_min;start+=30){
    const status=overlaps(bookings,start)?'booked':overlaps(blocks,start)?'blocked':`${date} ${time(start)}`<=now?'past':atCapacity?'full':'available';
    slots.push({start_time:time(start),end_time:time(start+30),available:status==='available',status});
  }
  const available_count=slots.filter(slot=>slot.available).length;
  const status=outside?'unavailable':closed?'closed':available_count?'available':'full';
  const reason=outside?'예약 가능 기간이 아닙니다.':closed?'휴무일입니다.':atCapacity?'일일 예약 한도에 도달했습니다.':!available_count?'예약 가능한 시간이 없습니다.':'';
  return {date,slots,booked_count:bookings.length,daily_limit:rule?.daily_limit??0,available_count,closed,status,reason};
}
