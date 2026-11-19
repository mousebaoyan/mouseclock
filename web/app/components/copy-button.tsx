import { useState } from "react";
import { Button } from "./ui/button.tsx";

// Copies a text in one click (design §13), and says so for a moment.
export function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }
  return (
    <Button type="button" variant="outline" size="sm" onClick={() => void copy()}>
      {copied ? "已复制" : "复制"}
    </Button>
  );
}
