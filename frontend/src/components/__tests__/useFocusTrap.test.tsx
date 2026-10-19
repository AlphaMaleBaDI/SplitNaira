/* @vitest-environment jsdom */

import { useRef, useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { useFocusTrap } from "../useFocusTrap";

function TrapHost({
  withFocusables = true,
  open = true,
}: {
  withFocusables?: boolean;
  open?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref, open);

  return (
    <div>
      <button type="button">Outside trigger</button>
      <div ref={ref} role="dialog" aria-label="Trap subject">
        {withFocusables ? (
          <>
            <button type="button">First</button>
            <button type="button">Second</button>
            <button type="button">Third</button>
          </>
        ) : (
          <p>No interactive children</p>
        )}
      </div>
    </div>
  );
}

describe("useFocusTrap", () => {
  it("focuses the first focusable element inside the trap when opened", () => {
    render(<TrapHost />);
    expect(screen.getByText("First")).toHaveFocus();
  });

  it("focuses the trap container itself when it has no focusable children", () => {
    render(<TrapHost withFocusables={false} />);
    // No focusable children — the trap container itself receives focus.
    const dialog = screen.getByRole("dialog", { hidden: true });
    expect(dialog).toHaveFocus();
  });

  it("wraps Tab from the last focusable back to the first", async () => {
    const user = userEvent.setup();
    render(<TrapHost />);

    const first = screen.getByText("First");
    const second = screen.getByText("Second");
    const third = screen.getByText("Third");

    expect(first).toHaveFocus();
    await user.tab();
    expect(second).toHaveFocus();
    await user.tab();
    expect(third).toHaveFocus();
    await user.tab();
    expect(first).toHaveFocus();
  });

  it("wraps Shift+Tab from the first focusable back to the last", async () => {
    const user = userEvent.setup();
    render(<TrapHost />);

    expect(screen.getByText("First")).toHaveFocus();
    await user.tab({ shift: true });
    expect(screen.getByText("Third")).toHaveFocus();
  });

  it("does not trap focus when the open flag is false", async () => {
    function ClosedHost() {
      const ref = useRef<HTMLDivElement>(null);
      useFocusTrap(ref, false);
      return (
        <div>
          <button type="button">Outside trigger</button>
          <div ref={ref} role="dialog" aria-label="Closed dialog">
            <button type="button">Inside First</button>
            <button type="button">Inside Second</button>
          </div>
        </div>
      );
    }

    render(<ClosedHost />);
    // When `open` is false the trap's effect short-circuits, so focus is
    // neither pulled into the dialog nor redirected back. The trigger that
    // mounted first remains unfocused.
    expect(screen.getByText("Outside trigger")).not.toHaveFocus();
    expect(screen.getByText("Inside First")).not.toHaveFocus();
    expect(screen.getByText("Inside Second")).not.toHaveFocus();
  });

  it("traps focus once the open flag becomes true (post-mount transition)", async () => {
    function ToggleableHost() {
      const [open, setOpen] = useState(false);
      return (
        <div>
          <button type="button" onClick={() => setOpen(true)}>
            Open
          </button>
          {open && (
            <div role="dialog" aria-label="Trap subject">
              <InnerTrap />
            </div>
          )}
        </div>
      );
    }
    function InnerTrap() {
      const ref = useRef<HTMLDivElement>(null);
      useFocusTrap(ref, true);
      return (
        <div ref={ref}>
          <button type="button">Trap First</button>
        </div>
      );
    }

    const user = userEvent.setup();
    render(<ToggleableHost />);
    // Trigger the dialog open. After the open transition, the trap's effect
    // pulls focus into the first focusable element of the trap.
    await user.click(screen.getByText("Open"));
    expect(screen.getByText("Trap First")).toHaveFocus();
  });
});
