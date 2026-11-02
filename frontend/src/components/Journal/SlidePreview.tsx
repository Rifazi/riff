'use client';

import type { DeckSlide, DeckStyle } from '@/lib/decks/api';

const clip = (s: string | undefined, n: number) => (s && s.length > n ? `${s.slice(0, n - 1)}…` : (s ?? ''));

/** A small 16:9 sketch of one slide in the deck's theme: enough to judge the layout and look, not pixel-exact. */
export function SlidePreview({ slide, style }: { slide: DeckSlide; style: DeckStyle }) {
  const bold = slide.layout === 'title' || slide.layout === 'section';
  const wide = bold || slide.layout === 'closing';
  const ink = bold ? style.onPrimary : style.text;
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
      style={{ background: bold ? style.primary : style.bg, color: ink, borderColor: style.border, fontFamily: style.bodyFont }}
    >
      <div className={`absolute inset-0 flex flex-col ${wide ? 'justify-center px-[7.5%]' : 'px-[7.5%] pt-[10%]'} gap-1`}>
        {title && (
          <div
            className={wide ? 'text-[13px] font-bold' : 'text-[10px] font-bold'}
            style={{ fontFamily: style.headingFont }}
          >
            {clip(title, 60)}
          </div>
        )}
        {slide.subtitle && <div style={{ opacity: 0.85 }}>{clip(slide.subtitle, 80)}</div>}
        {slide.layout === 'bullets' && <div className="mt-1 space-y-0.5">{bullets(slide.bullets, 5)}</div>}
        {slide.layout === 'closing' && <div className="mt-1 space-y-0.5">{bullets(slide.bullets)}</div>}
        {slide.layout === 'two_column' && (
          <div className="mt-1 grid grid-cols-2 gap-2">
            {[slide.left, slide.right].map((col, i) => (
              <div key={i} className="pt-1" style={{ borderTop: `1px solid ${style.border}` }}>
                <div className="font-bold" style={{ color: style.primary }}>{clip(col?.heading, 24)}</div>
                {bullets(col?.bullets, 3)}
              </div>
            ))}
          </div>
        )}
        {slide.layout === 'stat' && (
          <div className="mt-1 flex gap-2">
            {(slide.stats ?? []).map((st, i) => (
              <div key={i} className="flex-1 pt-1" style={{ borderTop: `1px solid ${style.border}` }}>
                <div className="text-[18px] font-bold tracking-tight" style={{ color: style.primary, fontFamily: style.headingFont }}>{st.value}</div>
                <div>{clip(st.label, 30)}</div>
              </div>
            ))}
          </div>
        )}
        {slide.layout === 'quote' && (
          <div className="text-[10px]" style={{ fontFamily: style.headingFont }}>
            <span className="text-[18px] leading-none" style={{ color: style.primary }}>&ldquo;</span> {clip(slide.quote, 110)}
            {slide.attribution && <div className="not-italic" style={{ color: style.textMuted }}>— {clip(slide.attribution, 30)}</div>}
          </div>
        )}
        {slide.layout === 'table' && (
          <div className="mt-1">
            <div className="flex font-bold" style={{ color: style.textMuted, borderBottom: `1px solid ${style.text}` }}>
              {(slide.columns ?? []).map((c, i) => <div key={i} className="flex-1 px-1">{clip(c, 14)}</div>)}
            </div>
            {(slide.rows ?? []).slice(0, 3).map((r, ri) => (
              <div key={ri} className="flex" style={{ borderBottom: `1px solid ${style.border}` }}>
                {r.map((cell, i) => <div key={i} className="flex-1 px-1">{clip(cell, 14)}</div>)}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
