import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsPage } from "../src/pages/SettingsPage";
import { renderWithApp, stubApi } from "./render";

afterEach(() => vi.unstubAllGlobals());

function setUp() {
  const fetch = stubApi({ "/auth/password": null });
  renderWithApp(<SettingsPage />);
  const type = (label: string, value: string) =>
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
  const submit = () => fireEvent.click(screen.getByRole("button", { name: "Change password" }));
  const passwordCalls = () =>
    fetch.mock.calls.filter(([input]) => String(input).endsWith("/auth/password"));
  return { type, submit, passwordCalls };
}

describe("SettingsPage account", () => {
  it("won't send a new password that doesn't match its repeat", async () => {
    const page = setUp();
    page.type("Current password", "correct horse");
    page.type("New password", "battery staple");
    page.type("Repeat new password", "battery stapler");
    page.submit();
    expect(await screen.findByText("The passwords don't match.")).toBeTruthy();
    expect(page.passwordCalls()).toHaveLength(0);
  });

  it("changes the password and clears the form", async () => {
    const page = setUp();
    page.type("Current password", "correct horse");
    page.type("New password", "battery staple");
    page.type("Repeat new password", "battery staple");
    page.submit();
    expect(await screen.findByText("Password changed.")).toBeTruthy();
    const init = page.passwordCalls()[0]?.[1];
    expect(JSON.parse(String(init?.body))).toEqual({
      currentPassword: "correct horse",
      newPassword: "battery staple",
    });
    await waitFor(() =>
      expect(screen.getByLabelText<HTMLInputElement>("Current password").value).toBe(""),
    );
  });
});
