import { useEffect, useState } from 'react';

const QUERY = '(max-width: 767px)';

/** True on a phone-width screen (the phone app, or a very narrow window). False until mounted, so the first paint is the desktop layout. */
export function usePhone(): boolean {
  const [phone, setPhone] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(QUERY);
    const update = () => setPhone(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);
  return phone;
}
