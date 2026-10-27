import { createCn } from "cn/config";

// The theme's own font sizes (app.css), which cn would otherwise take for text colors and drop
// beside one, as in "text-meta text-primary".
export const cn = createCn({
  extend: { classGroups: { "font-size": [{ text: ["2xs", "meta", "body"] }] } },
});
