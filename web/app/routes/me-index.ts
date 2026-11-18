import { redirect } from "react-router";
import { ME_TABS } from "../me-tabs.ts";

export function loader() {
  return redirect(ME_TABS[0].to);
}
