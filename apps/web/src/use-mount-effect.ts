import { useEffect } from "react";

export const useMountEffect = (effect: () => void | (() => void)): void => {
  useEffect(effect, []);
};
