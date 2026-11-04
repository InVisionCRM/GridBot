/**
 * A figure whose digits roll to their new value, like an odometer. The figure stays one plain run of text (drawn
 * transparent: it sizes the slot and is what a screen reader, a copy or a server render reads, once). Over it, a layer
 * with no text of its own draws each character with CSS: a digit is a column 0–9 (styles.css .roll-col::before) that
 * slides to the digit shown; any other character is drawn from its data-ch attribute. Digits are keyed from the right,
 * so a figure that grows a digit rolls the digits it had instead of re-mounting them.
 */
export function Roll({ text, className = '' }: { text: string; className?: string }) {
  const chars = [...text];
  return (
    <span className={`roll ${className}`}>
      <span className="roll-txt">{text}</span>
      <span className="roll-over" aria-hidden="true">
        {chars.map((ch, i) => {
          const key = chars.length - i;
          return /\d/.test(ch)
            ? <span key={`d${key}`} className="roll-d"><span className="roll-col" style={{ transform: `translateY(${-Number(ch)}em)` }} /></span>
            : <span key={`c${key}`} className="roll-c" data-ch={ch} />;
        })}
      </span>
    </span>
  );
}
