import { useEffect, useState } from 'react';

function useMatch(query: string): boolean {
  const [on, setOn] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const read = () => setOn(mq.matches);
    read();
    mq.addEventListener('change', read);
    return () => mq.removeEventListener('change', read);
  }, [query]);
  return on;
}

/** iPhone-width layout. Hero may roll; chips and cards stay put. */
export function usePhone(): boolean {
  return useMatch('(max-width: 430px)');
}

export function useReducedMotion(): boolean {
  return useMatch('(prefers-reduced-motion: reduce)');
}
