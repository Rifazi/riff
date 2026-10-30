'use client';

import type { DeckSlide, DeckStyle } from '@/lib/decks/api';

const clip = (s: string | undefined, n: number) => (s && s.length > n ? `${s.slice(0, n - 1)}…` : (s ?? ''));

/** A small 16:9 sketch of one slide in the deck's theme: enough to judge the layout and look, not pixel-exact. */
export function SlidePreview({ slide, style }: { slide: DeckSlide; style: DeckStyle }) {
  const wide = slide.layout === 'title' || slide.layout === 'section' || slide.layout === 'closing';
  const title = slide.layout === 'quote' ? undefined : slide.title;
  const bullets = (items?: string[], max = 4) =>
    (items ?? []).slice(0, max).map((b, i) => (
      <div key={i} className="flex gap-1">
        <span style={{ color: style.primary }}>•</span>
        <span>{clip(b, 70)}</span>
      </div>
    ));

  return (
    <div
      className="relative aspect-video w-full overflow-hidden rounded border text-[8px] leading-tight"
      style={{ background: style.bg, color: style.text, borderColor: style.border, fontFamily: style.bodyFont }}
    >
      <div className="absolute inset-y-0 left-0" style={{ width: wide ? '4%' : '1.4%', background: style.primary }} />
      <div className={`absolute inset-0 flex flex-col ${wide ? 'justify-center pl-[9%] pr-[6%]' : 'px-[7%] pt-[6%]'} gap-1`}>
        {title && (
          <div
            className={wide ? 'text-[13px] font-bold' : 'text-[10px] font-bold'}
            style={{ fontFamily: style.headingFont }}
          >
            {clip(title, 60)}
          </div>
        )}
        {slide.subtitle && <div style={{ color: style.textMuted }}>{clip(slide.subtitle, 80)}</div>}
        {slide.layout === 'bullets' && <div className="mt-1 space-y-0.5">{bullets(slide.bullets, 5)}</div>}
        {slide.layout === 'closing' && <div className="mt-1 space-y-0.5">{bullets(slide.bullets)}</div>}
        {slide.layout === 'two_column' && (
          <div className="mt-1 grid grid-cols-2 gap-2">
            {[slide.left, slide.right].map((col, i) => (
              <div key={i} className="rounded p-1" style={{ background: style.surface, border: `1px solid ${style.border}` }}>
                <div className="font-bold" style={{ color: style.primary }}>{clip(col?.heading, 24)}</div>
                {bullets(col?.bullets, 3)}
              </div>
            ))}
          </div>
        )}
        {slide.layout === 'stat' && (
          <div className="mt-1 flex gap-2">
            {(slide.stats ?? []).map((st, i) => (
              <div key={i} className="flex-1 rounded p-1 text-center" style={{ background: style.surfaceMuted, border: `1px solid ${style.border}` }}>
                <div className="text-[14px] font-bold" style={{ color: style.primary, fontFamily: style.headingFont }}>{st.value}</div>
                <div>{clip(st.label, 30)}</div>
              </div>
            ))}
          </div>
        )}
        {slide.layout === 'quote' && (
          <div className="italic text-[10px]" style={{ fontFamily: style.headingFont }}>
            <span className="text-[18px] leading-none" style={{ color: style.primary }}>&ldquo;</span> {clip(slide.quote, 110)}
            {slide.attribution && <div className="not-italic" style={{ color: style.textMuted }}>— {clip(slide.attribution, 30)}</div>}
          </div>
        )}
        {slide.layout === 'table' && (
          <div className="mt-1 overflow-hidden rounded" style={{ border: `1px solid ${style.border}` }}>
            <div className="flex font-bold" style={{ background: style.primary, color: style.onPrimary }}>
              {(slide.columns ?? []).map((c, i) => <div key={i} className="flex-1 px-1">{clip(c, 14)}</div>)}
            </div>
            {(slide.rows ?? []).slice(0, 3).map((r, ri) => (
              <div key={ri} className="flex" style={{ background: ri % 2 ? style.surfaceMuted : style.surface }}>
                {r.map((cell, i) => <div key={i} className="flex-1 px-1">{clip(cell, 14)}</div>)}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
