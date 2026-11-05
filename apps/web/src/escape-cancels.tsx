import { useMountEffect } from "./use-mount-effect.ts";

export const EscapeCancels = ({ onCancel }: { onCancel: () => void }) => {
  useMountEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onCancel();
    };
    document.addEventListener("keydown", onKey, { capture: true });
    return () => document.removeEventListener("keydown", onKey, { capture: true });
  });
  return null;
};
