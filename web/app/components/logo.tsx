// Mousehole's mouse, all the way out of its hole and standing as an alarm clock: the ears are
// the bells, and it stands on the clock's feet. Strokes and colors are those of mousehole's mark.
export function LogoMark({ className }: { className?: string }) {
  const body = "fill-[#fffaf2] stroke-[#2f403d] dark:fill-[#2b3331] dark:stroke-[#e9e2d3]";
  const pink = "fill-[#f6b48c] dark:fill-[#c98863]";
  return (
    <svg viewBox="0 0 37 37" className={className} aria-hidden="true">
      <g className={body} strokeWidth={2.6} strokeLinecap="round">
        <path d="M12.2 28.4l-2.9 5M24.8 28.4l2.9 5" />
        <circle cx="10.2" cy="9.2" r="5.6" />
        <circle cx="26.8" cy="9.2" r="5.6" />
      </g>
      {/* Under the head, whose outline covers their edge. */}
      <g className={pink}>
        <circle cx="10.2" cy="9.2" r="2.2" />
        <circle cx="26.8" cy="9.2" r="2.2" />
      </g>
      <circle cx="18.5" cy="19.4" r="11" className={body} strokeWidth={2.6} />
      <g className="fill-[#2f403d] dark:fill-[#e9e2d3]">
        <circle cx="14.9" cy="20" r="1.5" />
        <circle cx="22.1" cy="20" r="1.5" />
      </g>
      <ellipse cx="18.5" cy="23.4" rx="1.9" ry="1.4" className={pink} />
    </svg>
  );
}
