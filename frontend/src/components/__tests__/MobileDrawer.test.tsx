/* @vitest-environment jsdom */

import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import { MobileDrawer } from "../MobileDrawer";

function DrawerHarness({ initiallyOpen = false }: { initiallyOpen?: boolean }) {
  const [open, setOpen] = useState(initiallyOpen);
  return (
    <div>
      <button type="button" onClick={() => setOpen(true)}>
        Open Drawer
      </button>
      <MobileDrawer isOpen={open} onClose={() => setOpen(false)}>
        <nav aria-label="Mobile navigation">
          <button type="button">Nav Item 1</button>
          <button type="button">Nav Item 2</button>
        </nav>
      </MobileDrawer>
    </div>
  );
}

describe("MobileDrawer accessibility", () => {
  afterEach(() => {
    // Defensive reset: if a test leaves body overflow hidden this would break
    // subsequent tests in this file. Cleanup() from the global setup already
    // resets the DOM, but body overflow persists across renders.
    document.body.style.overflow = "";
  });

  it("does not lock body scroll when closed", () => {
    render(<DrawerHarness initiallyOpen={false} />);
    expect(document.body.style.overflow).not.toBe("hidden");
  });

  it("locks body scroll while open", async () => {
    const user = userEvent.setup();
    render(<DrawerHarness />);

    await user.click(screen.getByText("Open Drawer"));
    expect(document.body.style.overflow).toBe("hidden");
  });

  it("releases the body scroll lock when the drawer closes via Escape", async () => {
    const user = userEvent.setup();
    render(<DrawerHarness />);

    await user.click(screen.getByText("Open Drawer"));
    expect(document.body.style.overflow).toBe("hidden");

    await user.keyboard("{Escape}");
    expect(document.body.style.overflow).not.toBe("hidden");
  });

  it("releases the body scroll lock when the drawer closes via backdrop click", async () => {
    const user = userEvent.setup();
    render(<DrawerHarness />);

    await user.click(screen.getByText("Open Drawer"));
    expect(document.body.style.overflow).toBe("hidden");

    // Backdrop is the first fixed inset-0 element when the drawer is open.
    await user.click(document.querySelector('[aria-hidden="true"]') as HTMLElement);
    expect(document.body.style.overflow).not.toBe("hidden");
  });

  it("releases the body scroll lock on unmount (no leak)", async () => {
    const user = userEvent.setup();
    function DisposableHost() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Open Disposable Drawer
          </button>
          <MobileDrawer isOpen={open} onClose={() => setOpen(false)}>
            <p>Disposable content</p>
          </MobileDrawer>
        </>
      );
    }

    const { unmount } = render(<DisposableHost />);
    await user.click(screen.getByText("Open Disposable Drawer"));
    expect(document.body.style.overflow).toBe("hidden");

    unmount();
    expect(document.body.style.overflow).not.toBe("hidden");
  });

  it("registers a document-level Escape handler that closes the drawer", async () => {
    const user = userEvent.setup();
    render(<DrawerHarness />);

    await user.click(screen.getByText("Open Drawer"));
    expect(screen.queryByLabelText("Mobile navigation")).toBeInTheDocument();

    await user.keyboard("{Escape}");
    expect(screen.queryByLabelText("Mobile navigation")).not.toBeInTheDocument();
  });

  it("removes the document-level Escape handler on unmount", () => {
    function DisposableHost() {
      const [open, setOpen] = useState(true);
      return (
        <MobileDrawer isOpen={open} onClose={() => setOpen(false)}>
          <p>Disposable</p>
        </MobileDrawer>
      );
    }

    const { unmount } = render(<DisposableHost />);
    unmount();
    // Pressing Escape after unmount must not throw or fire stale listeners.
    fireEvent.keyDown(document, { key: "Escape" });
  });
});
