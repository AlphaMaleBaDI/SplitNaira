import { useEffect, type RefObject } from "react";

export function useFocusTrap(ref: RefObject<HTMLElement | null>, isOpen: boolean) {
  useEffect(() => {
    if (!isOpen || !ref.current) return;

    const modal = ref.current;
    
    // Find all focusable elements
    const getFocusableElements = () => {
      return Array.from(
        modal.querySelectorAll<HTMLElement>(
          'a[href], area[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), iframe, object, embed, [tabindex="0"], [contenteditable]'
        )
      ).filter((el) => el.getAttribute("tabindex") !== "-1");
    };

    // Auto-focus the first element
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
        return;
      }

      const firstEl = elements[0];
      const lastEl = elements[elements.length - 1];

      if (e.shiftKey) {
        // Shift + Tab -> reverse wrap
        if (document.activeElement === firstEl || document.activeElement === modal) {
          lastEl.focus();
          e.preventDefault();
        }
      } else {
        // Tab -> forward wrap
        if (document.activeElement === lastEl) {
          firstEl.focus();
          e.preventDefault();
        }
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen, ref]);
}
