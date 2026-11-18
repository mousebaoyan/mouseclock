import { Outlet, useLocation } from "react-router";
import { Page } from "~/components/page";
import { Segmented } from "~/components/ui/segmented";
import { ME_TABS } from "../me-tabs.ts";

export function meta() {
  return [{ title: "我的 · 鼠钟" }];
}

// One tab for each thing of one's own, each at its own address (design §10.2).
export default function Me() {
  const { pathname } = useLocation();
  return (
    <Page title="我的" hideTitle>
      <Segmented
        label="我的"
        items={ME_TABS.map((tab) => ({ ...tab, on: pathname.startsWith(tab.to) }))}
      />
      <Outlet />
    </Page>
  );
}
