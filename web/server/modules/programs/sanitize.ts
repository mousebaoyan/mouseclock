import { FilterXSS } from "xss";

// A notice page as snapshots show it (design §15): its text, headings, lists, tables and links,
// and nothing that runs, loads or restyles our page. Images are left out too: showing them would
// load them from the college's site in every reader's browser (AGENTS.md, 对源站友好).

const TAGS = [
  "p",
  "br",
  "div",
  "span",
  "strong",
  "b",
  "em",
  "i",
  "u",
  "s",
  "sub",
  "sup",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "ul",
  "ol",
  "li",
  "blockquote",
  "pre",
  "code",
  "hr",
  "table",
  "caption",
  "thead",
  "tbody",
  "tfoot",
  "tr",
];
const whiteList = {
  ...Object.fromEntries(TAGS.map((tag) => [tag, []])),
  a: ["href"],
  td: ["colspan", "rowspan"],
  th: ["colspan", "rowspan"],
};
const PROTOCOLS = ["http:", "https:", "mailto:"];

// Links are made absolute against the page they were on, and open the college's site apart.
export function sanitizeSnapshot(html: string, pageUrl: string) {
  return new FilterXSS({
    whiteList,
    stripIgnoreTag: true,
    // xss can't strip one of these nested in its own kind; what is left shows as text, never runs.
    stripIgnoreTagBody: ["title", "script", "style", "noscript", "template", "iframe", "svg"],
    onTagAttr(tag, name, value) {
      if (tag !== "a" || name !== "href") return undefined;
      const url = URL.parse(value, pageUrl);
      if (!url || !PROTOCOLS.includes(url.protocol)) return "";
      // The value is as the page wrote it, so the browser decodes its entities, such as &amp;, as
      // it would there; one spelling its scheme in entities resolves as a path on the site, still
      // http(s). Only a quote could end it: xss's escapers are none of the names Node imports.
      const href = url.href.replaceAll('"', "&quot;");
      return `href="${href}" target="_blank" rel="nofollow noopener noreferrer"`;
    },
  }).process(html);
}
