/** Which front end a page load gets: the classic app, or the read-only desk when the address asks for it. */
export const deskRequested = (search: string): boolean => new URLSearchParams(search).has('desk');
