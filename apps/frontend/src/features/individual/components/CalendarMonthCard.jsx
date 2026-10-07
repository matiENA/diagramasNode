import React from 'react';
import { CalendarDayCell } from './CalendarDayCell';

export const CalendarMonthCard = ({
  year,
  monthIndex, // 0..11
  monthName,
  tiraDias, // string "1,2,F,F,..."
  isActiveMonth,
  todayIso,
  selectedRange,
  tripsMap,
  onDayClick,
}) => {
  const daysInMonth = new Date(year, monthIndex + 1, 0).getDate();
  const firstDayOfWeek = new Date(year, monthIndex, 1).getDay();
  // Lunes = 0, Domingo = 6
  const startOffset = firstDayOfWeek === 0 ? 6 : firstDayOfWeek - 1;

  const diasArray = (tiraDias || '').split(',');
  const headers = ['L', 'M', 'X', 'J', 'V', 'S', 'D'];

  const isDaySelected = (isoStr) => {
    if (!selectedRange || !selectedRange.startIso || !selectedRange.endIso) return false;
    const { startIso, endIso } = selectedRange;
    const minIso = startIso <= endIso ? startIso : endIso;
    const maxIso = startIso <= endIso ? endIso : startIso;
    return isoStr >= minIso && isoStr <= maxIso;
  };

  return (
    <div className={`calendar-month-card ${isActiveMonth ? 'current-active-month' : ''}`}>
      {/* Título del Mes */}
      <div className="month-title-header">
        {monthName} {year}
      </div>

      {/* Cabecera L M X J V S D */}
      <div className="month-days-table">
        {headers.map((h, i) => (
          <div key={i} className="day-col-header">{h}</div>
        ))}

        {/* Celdas vacías previas al día 1 */}
        {Array.from({ length: startOffset }, (_, i) => (
          <div key={`empty-${i}`} className="day-cell-placeholder" />
        ))}

        {/* Días del Mes */}
        {Array.from({ length: daysInMonth }, (_, i) => {
          const dayNum = i + 1;
          const monthStr = String(monthIndex + 1).padStart(2, '0');
          const dayStr = String(dayNum).padStart(2, '0');
          const isoStr = `${year}-${monthStr}-${dayStr}`;
          const rawStatus = diasArray[i] || '';
          const isToday = isoStr === todayIso;
          const isSelected = isDaySelected(isoStr);
          const trip = tripsMap?.[isoStr];
          const hasKm = Boolean(trip && trip.km > 0);
          const tractorTag = trip?.tractor ? ` · ${trip.tractor}` : '';
          const uteTag = trip?.n_ute ? ` (UTE ${trip.n_ute})` : '';
          const kmTooltip = hasKm ? `${trip.km} km${trip.hr ? ' (HR: ' + trip.hr + ')' : ''}${tractorTag}${uteTag}` : undefined;

          return (
            <CalendarDayCell
              key={isoStr}
              dayNum={dayNum}
              isoStr={isoStr}
              rawStatus={rawStatus}
              isSelected={isSelected}
              isToday={isToday}
              hasKm={hasKm}
              kmTooltip={kmTooltip}
              onClick={onDayClick}
            />
          );
        })}
      </div>
    </div>
  );
};
