// Rows per page that every list offers, the first by default. Apart from http.ts so pages can
// import it without bringing Zod and Hono into the browser's bundle.
export const PER_PAGE = [20, 50, 100] as const;
