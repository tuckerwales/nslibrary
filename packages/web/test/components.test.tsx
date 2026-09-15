import { useMutation } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { ConfirmPanel } from "../src/components/ConfirmPanel";
import { Switch } from "../src/components/Field";
import { TitleIcon } from "../src/components/TitleIcon";
import { Toaster } from "../src/components/Toaster";
import { createQueryClient } from "../src/query-client";
import { renderWithApp } from "./render";

describe("TitleIcon", () => {
  it("tries a new icon URL after an earlier one failed", () => {
    const { container, rerender } = render(<TitleIcon name="Example" seed="1" url="/a.png" />);
    fireEvent.error(container.querySelector("img") as HTMLImageElement);
    expect(container.querySelector("img")).toBeNull();

    rerender(<TitleIcon name="Example" seed="1" url="/b.png" />);
    expect(container.querySelector("img")?.getAttribute("src")).toBe("/b.png");
  });

  it("fills its container when asked to", () => {
    const { container } = render(<TitleIcon name="Example Game" seed="1" url={null} size="fill" />);
    const tile = container.firstElementChild as HTMLElement;
    expect(tile.className).toContain("w-full");
    expect(tile.style.width).toBe("");
    expect(tile.textContent).toBe("EG");
  });
});

describe("Switch", () => {
  it("toggles when its label is clicked", () => {
    function Harness() {
      const [on, setOn] = useState(false);
      return <Switch label="Prefer NSZ" checked={on} onChange={setOn} />;
    }
    render(<Harness />);
    const toggle = screen.getByRole("switch", { name: "Prefer NSZ" });
    fireEvent.click(screen.getByText("Prefer NSZ"));
    expect(toggle.getAttribute("aria-checked")).toBe("true");
  });
});

describe("ConfirmPanel", () => {
  it("takes focus, closes on Escape, and returns focus to its opener", async () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Remove
          </button>
          {open && (
            <ConfirmPanel
              label="Remove folder"
              confirmLabel="Remove folder"
              onConfirm={() => setOpen(false)}
              onCancel={() => setOpen(false)}
            >
              <p>Sure?</p>
            </ConfirmPanel>
          )}
        </>
      );
    }
    render(<Harness />);
    const opener = screen.getByRole("button", { name: "Remove" });
    opener.focus();
    fireEvent.click(opener);

    const dialog = await screen.findByRole("alertdialog", { name: "Remove folder" });
    await waitFor(() => expect(document.activeElement).toBe(dialog));

    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("alertdialog")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });
});

describe("mutation errors", () => {
  function Harness({ inline }: { inline: boolean }) {
    const mutation = useMutation({
      mutationFn: async () => {
        throw new Error(inline ? "Shown inline" : "Shown as toast");
      },
      meta: { inlineError: inline },
    });
    return (
      <button type="button" onClick={() => mutation.mutate()}>
        Go
      </button>
    );
  }

  it("shows a toast unless the page shows the error itself", async () => {
    const client = createQueryClient();
    renderWithApp(
      <>
        <Harness inline={false} />
        <Harness inline />
        <Toaster />
      </>,
      { client },
    );
    const [toastButton, inlineButton] = screen.getAllByRole("button", { name: "Go" });
    await act(async () => {
      fireEvent.click(toastButton as HTMLElement);
      fireEvent.click(inlineButton as HTMLElement);
    });
    expect(await screen.findByText("Shown as toast")).toBeTruthy();
    expect(screen.queryByText("Shown inline")).toBeNull();
  });
});
