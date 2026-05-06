'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { addPlanningItem, deletePlanningItem } from '@/app/actions/planning';
import { ACTIVITY_META, type ActivityKind } from '@/lib/activity-meta';
import type { CalendarItem } from '@/app/page';

const WEEK_DAYS = ['Lu', 'Ma', 'Me', 'Je', 'Ve', 'Sa', 'Di'];
const MONTH_NAMES = [
  'Janvier', 'Février', 'Mars', 'Avril', 'Mai', 'Juin',
  'Juillet', 'Août', 'Septembre', 'Octobre', 'Novembre', 'Décembre',
];

function localDateStr(date: Date): string {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');
}

function buildGrid(year: number, month: number) {
  const firstDay = new Date(year, month - 1, 1);
  const lastDay = new Date(year, month, 0);
  const startOffset = (firstDay.getDay() + 6) % 7; // Mon=0 … Sun=6

  const cells: { dateStr: string; isCurrentMonth: boolean }[] = [];

  for (let i = startOffset - 1; i >= 0; i--) {
    cells.push({ dateStr: localDateStr(new Date(year, month - 1, -i)), isCurrentMonth: false });
  }
  for (let d = 1; d <= lastDay.getDate(); d++) {
    cells.push({ dateStr: localDateStr(new Date(year, month - 1, d)), isCurrentMonth: true });
  }
  const remaining = 42 - cells.length;
  for (let d = 1; d <= remaining; d++) {
    cells.push({ dateStr: localDateStr(new Date(year, month, d)), isCurrentMonth: false });
  }
  return cells;
}

function shiftMonth(m: string, delta: number): string {
  const [y, mo] = m.split('-').map(Number);
  const d = new Date(y, mo - 1 + delta, 1);
  return localDateStr(d).slice(0, 7);
}

export function CalendarView({
  month,
  draftId,
  items,
  userName,
}: {
  month: string;
  draftId: string;
  items: CalendarItem[];
  userName: string;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [kind, setKind] = useState<ActivityKind>('off');
  const [endDate, setEndDate] = useState('');

  const [year, mo] = month.split('-').map(Number);
  const cells = buildGrid(year, mo);
  const today = localDateStr(new Date());

  // Expand multi-day items onto every day they cover
  const itemsByDate = new Map<string, CalendarItem[]>();
  for (const item of items) {
    const start = new Date(item.start_date + 'T00:00:00');
    const end = new Date(item.end_date + 'T00:00:00');
    for (const d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      const ds = localDateStr(new Date(d));
      if (!itemsByDate.has(ds)) itemsByDate.set(ds, []);
      itemsByDate.get(ds)!.push(item);
    }
  }

  function openDay(dateStr: string) {
    setSelectedDate(dateStr);
    setEndDate(dateStr);
    setKind('off');
  }

  function handleAdd() {
    if (!selectedDate) return;
    startTransition(async () => {
      await addPlanningItem({ draft_id: draftId, kind, start_date: selectedDate, end_date: endDate || selectedDate });
    });
  }

  function handleDelete(itemId: string) {
    startTransition(async () => {
      await deletePlanningItem(itemId);
    });
  }

  const selectedItems = selectedDate ? (itemsByDate.get(selectedDate) ?? []) : [];

  const sortedKinds = (Object.keys(ACTIVITY_META) as ActivityKind[]).sort(
    (a, b) => ACTIVITY_META[a].order - ACTIVITY_META[b].order
  );

  return (
    <div className="flex flex-col min-h-screen">
      {/* Header */}
      <header className="sticky top-0 z-10 flex items-center justify-between px-4 py-3 bg-zinc-50 dark:bg-zinc-950 border-b border-zinc-200 dark:border-zinc-800">
        <span className="text-sm font-semibold tracking-tight">CM-offline</span>
        <div className="flex items-center gap-2">
          <button
            onClick={() => router.push(`/?m=${shiftMonth(month, -1)}`)}
            className="w-7 h-7 flex items-center justify-center rounded hover:bg-zinc-200 dark:hover:bg-zinc-800 text-lg leading-none"
          >
            ‹
          </button>
          <span className="text-sm font-medium w-36 text-center">
            {MONTH_NAMES[mo - 1]} {year}
          </span>
          <button
            onClick={() => router.push(`/?m=${shiftMonth(month, 1)}`)}
            className="w-7 h-7 flex items-center justify-center rounded hover:bg-zinc-200 dark:hover:bg-zinc-800 text-lg leading-none"
          >
            ›
          </button>
        </div>
        <Link href="/onboarding" className="text-xs text-zinc-400 hover:text-zinc-600 truncate max-w-24 text-right">
          {userName}
        </Link>
      </header>

      {/* Day-of-week header */}
      <div className="grid grid-cols-7 border-b border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-950">
        {WEEK_DAYS.map((d) => (
          <div key={d} className="py-1.5 text-center text-xs font-medium text-zinc-400">
            {d}
          </div>
        ))}
      </div>

      {/* Calendar grid */}
      <div className={`grid grid-cols-7 flex-1 transition-opacity ${isPending ? 'opacity-50' : ''}`}>
        {cells.map(({ dateStr, isCurrentMonth }) => {
          const dayItems = itemsByDate.get(dateStr) ?? [];
          const isToday = dateStr === today;
          const isSelected = dateStr === selectedDate;
          const dayNum = new Date(dateStr + 'T00:00:00').getDate();

          return (
            <button
              key={dateStr}
              onClick={() => openDay(dateStr)}
              className={[
                'min-h-14 sm:min-h-20 p-1 border-b border-r border-zinc-100 dark:border-zinc-800 text-left flex flex-col gap-0.5',
                !isCurrentMonth ? 'bg-zinc-50/60 dark:bg-zinc-900/20' : '',
                isSelected ? 'bg-blue-50 dark:bg-blue-950/40 ring-1 ring-inset ring-blue-300 dark:ring-blue-700' : 'hover:bg-zinc-100 dark:hover:bg-zinc-800/40',
              ].filter(Boolean).join(' ')}
            >
              <span className={[
                'text-[11px] font-medium self-end leading-none',
                isCurrentMonth ? 'text-zinc-700 dark:text-zinc-200' : 'text-zinc-300 dark:text-zinc-600',
                isToday ? 'bg-blue-500 text-white rounded-full w-4 h-4 flex items-center justify-center text-[9px]' : '',
              ].filter(Boolean).join(' ')}>
                {dayNum}
              </span>
              <div className="flex flex-col gap-px w-full overflow-hidden">
                {dayItems.slice(0, 3).map((item) => {
                  const meta = ACTIVITY_META[item.kind];
                  return (
                    <span
                      key={item.id + dateStr}
                      className="text-[9px] sm:text-[10px] px-1 rounded-sm truncate leading-tight py-px"
                      style={{ backgroundColor: meta.color, color: meta.textColor }}
                    >
                      {meta.label}
                    </span>
                  );
                })}
                {dayItems.length > 3 && (
                  <span className="text-[9px] text-zinc-400 pl-1">+{dayItems.length - 3}</span>
                )}
              </div>
            </button>
          );
        })}
      </div>

      {/* Bottom sheet */}
      {selectedDate && (
        <>
          <div className="fixed inset-0 z-20 bg-black/20" onClick={() => setSelectedDate(null)} />
          <div className="fixed bottom-0 left-0 right-0 z-30 bg-white dark:bg-zinc-900 rounded-t-2xl shadow-xl max-h-[80vh] overflow-y-auto">
            <div className="p-4 space-y-4">
              {/* Sheet header */}
              <div className="flex items-center justify-between">
                <h2 className="font-semibold text-sm capitalize">
                  {new Date(selectedDate + 'T00:00:00').toLocaleDateString('fr-FR', {
                    weekday: 'long', day: 'numeric', month: 'long',
                  })}
                </h2>
                <button
                  onClick={() => setSelectedDate(null)}
                  className="text-zinc-400 hover:text-zinc-600 text-xl leading-none"
                >
                  ×
                </button>
              </div>

              {/* Existing activities */}
              {selectedItems.length > 0 && (
                <div className="space-y-1">
                  {selectedItems.map((item) => {
                    const meta = ACTIVITY_META[item.kind];
                    const isMultiDay = item.start_date !== item.end_date;
                    return (
                      <div
                        key={item.id}
                        className="flex items-center justify-between rounded-lg px-3 py-2"
                        style={{ backgroundColor: meta.color + '28' }}
                      >
                        <div>
                          <span className="text-sm font-medium" style={{ color: meta.color }}>
                            {meta.label}
                          </span>
                          {isMultiDay && (
                            <span className="ml-2 text-xs text-zinc-400">
                              {new Date(item.start_date + 'T00:00:00').toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })}
                              {' → '}
                              {new Date(item.end_date + 'T00:00:00').toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })}
                            </span>
                          )}
                        </div>
                        <button
                          onClick={() => handleDelete(item.id)}
                          className="text-zinc-300 hover:text-red-400 text-lg leading-none ml-3"
                        >
                          ×
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Add new activity */}
              <div className="space-y-3">
                <p className="text-xs font-medium text-zinc-500 uppercase tracking-wide">Ajouter</p>

                {/* Kind selector */}
                <div className="grid grid-cols-4 gap-1.5">
                  {sortedKinds.map((k) => {
                    const meta = ACTIVITY_META[k];
                    return (
                      <button
                        key={k}
                        type="button"
                        onClick={() => setKind(k)}
                        className={[
                          'rounded-lg py-2 px-1 text-[11px] font-medium text-center border-2 transition-all',
                          kind === k ? 'border-zinc-800 dark:border-zinc-100 scale-105' : 'border-transparent',
                        ].join(' ')}
                        style={{ backgroundColor: meta.color, color: meta.textColor }}
                      >
                        {meta.label}
                      </button>
                    );
                  })}
                </div>

                {/* Date range + submit */}
                <div className="flex items-end gap-2">
                  <div className="flex-1">
                    <label className="block text-xs text-zinc-500 mb-1">Jusqu'au</label>
                    <input
                      type="date"
                      value={endDate}
                      min={selectedDate}
                      onChange={(e) => setEndDate(e.target.value)}
                      className="w-full rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-3 py-2 text-sm"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={handleAdd}
                    disabled={isPending}
                    className="rounded-lg bg-zinc-900 px-5 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
                  >
                    Ajouter
                  </button>
                </div>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
