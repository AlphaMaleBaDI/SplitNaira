import { useLayoutEffect, type RefObject } from "react";

export function useFocusTrap(ref: RefObject<HTMLElement | null>, isOpen: boolean) {
  useLayoutEffect(() => {
    if (!isOpen || !ref.current) return;

    const modal = ref.current;
    const previousTabIndex = modal.getAttribute("tabindex");
    if (previousTabIndex === null) {
      modal.setAttribute("tabindex", "-1");
    }

    const getFocusableElements = () => {
      return Array.from(
        modal.querySelectorAll<HTMLElement>(
          'a[href], area[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), iframe, object, embed, [tabindex="0"], [contenteditable]'
        )
      ).filter((el) => el.getAttribute("tabindex") !== "-1");
    };

    const focusable = getFocusableElements();
    if (focusable.length > 0) {
      focusable[0].focus();
    } else {
      modal.focus();
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;

      const elements = getFocusableElements();
      if (elements.length === 0) {
        e.preventDefault();
        modal.focus();
        return;
      }

      const firstEl = elements[0];
      const lastEl = elements[elements.length - 1];
      const activeElement = document.activeElement;

      if (!modal.contains(activeElement)) {
        e.preventDefault();
        (e.shiftKey ? lastEl : firstEl).focus();
        return;
      }

      if (e.shiftKey) {
        if (document.activeElement === firstEl || document.activeElement === modal) {
          lastEl.focus();
          e.preventDefault();
        }
      } else if (document.activeElement === lastEl) {
        firstEl.focus();
        e.preventDefault();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      if (previousTabIndex === null) {
        modal.removeAttribute("tabindex");
      } else {
        modal.setAttribute("tabindex", previousTabIndex);
      }
    };
  }, [isOpen, ref]);
}
