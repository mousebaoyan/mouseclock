import { cn } from "~/cn";

// Links to download a cohort's programs (design §13): files the API serves, not pages.
export function Downloads({ cohort, className }: { cohort: number; className?: string }) {
  return (
    <p className={cn("flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px]", className)}>
      <span className="text-muted-foreground">下载 {cohort} 届的全部项目：</span>
      <a href={`/api/v1/export?cohort=${cohort}&format=csv`} download className="link">
        CSV（Excel 能直接打开）
      </a>
      <a href={`/api/v1/export?cohort=${cohort}&format=json`} download className="link">
        JSON（带全部字段和证据）
      </a>
    </p>
  );
}
