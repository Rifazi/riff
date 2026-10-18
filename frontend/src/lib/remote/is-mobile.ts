/** True in the phone build (`RIFF_MOBILE=1`): invoke/listen go over the network bridge. */
export const IS_MOBILE = process.env.NEXT_PUBLIC_RIFF_MOBILE === '1';
