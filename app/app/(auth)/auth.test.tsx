import { Slot } from "expo-router";
import { act, fireEvent, renderRouter, screen, waitFor } from "expo-router/testing-library";
import { Text } from "react-native";

import type { AuthStatus } from "../../src/auth/AuthProvider";
import type { TokenResponse } from "../../src/auth/api";
import RootLayout from "../_layout";
import Invite from "./invite";
import Login from "./login";
import LoginTotp from "./login-totp";

const mockAuth = {
  status: "signedOut" as AuthStatus,
  userId: null as string | null,
  getAccessToken: jest.fn(async () => "access"),
  refreshAccessToken: jest.fn(async () => "access"),
  signIn: jest.fn(async () => {}),
  signOut: jest.fn(async () => {}),
};

jest.mock("../../src/auth/AuthProvider", () => ({
  AuthProvider: ({ children }: { children: unknown }) => children,
  useAuth: () => mockAuth,
}));

const mockApi = {
  login: jest.fn(),
  loginTotp: jest.fn(),
  acceptInvite: jest.fn(),
  confirmInvite: jest.fn(),
  refresh: jest.fn(),
  logout: jest.fn(),
};

jest.mock("../../src/auth/api", () => ({
  get authApi() {
    return mockApi;
  },
}));

const mockDb = {
  connect: jest.fn(async () => {}),
  disconnect: jest.fn(async () => {}),
  disconnectAndClear: jest.fn(async () => {}),
};

// The root banners count the sync problems.
let mockProblemCount = 0;
jest.mock("@powersync/react", () => ({
  ...jest.requireActual("@powersync/react"),
  useQuery: () => ({ data: [{ n: mockProblemCount }], isLoading: false }),
  // The fake database never syncs, so the recurring generator does not run.
  useStatus: () => ({ hasSynced: false }),
}));

jest.mock("../../src/data/db", () => ({ createDatabase: async () => mockDb }));

jest.mock("expo-font", () => ({ useFonts: () => [true, null] }));

jest.mock("expo-clipboard", () => ({ setStringAsync: jest.fn(async () => true) }));

jest.mock("react-native-qrcode-svg", () => {
  const { Text: MockText } = jest.requireActual<typeof import("react-native")>("react-native");
  return function MockQRCode({ value }: { value: string }) {
    return <MockText testID="totp-qr">{value}</MockText>;
  };
});

const Clipboard = jest.requireMock("expo-clipboard") as { setStringAsync: jest.Mock };

const tokens: TokenResponse = {
  access_token: "access-1",
  expires_in: 600,
  user_id: "user-1",
  session_id: "session-1",
  refresh_token: "refresh-1",
};

const RECOVERY_CODES = Array.from({ length: 10 }, (_, i) => `code-${i}`);

function renderApp(initialUrl: string) {
  return renderRouter(
    {
      _layout: RootLayout,
      "(auth)/login": Login,
      "(auth)/login-totp": LoginTotp,
      "(auth)/invite": Invite,
      "(main)/_layout": () => <Slot />,
      "(main)/spending": () => <Text>Spending page</Text>,
      "sync-problems": () => <Text>Sync problems page</Text>,
    },
    { initialUrl },
  );
}

beforeEach(() => {
  mockProblemCount = 0;
  jest.clearAllMocks();
  mockAuth.status = "signedOut";
  mockAuth.userId = null;
});

async function goToTotp() {
  mockApi.login.mockResolvedValue({ ok: true, value: { mfa_token: "mfa-1" } });
  const router = await renderApp("/login");
  await fireEvent.changeText(await screen.findByLabelText("Email"), "ana@example.com");
  await fireEvent.changeText(screen.getByLabelText("Password"), "correct horse battery");
  await fireEvent.press(screen.getByRole("button", { name: "Log in" }));
  await waitFor(() => expect(router.getPathname()).toBe("/login-totp"));
  return router;
}

describe("login", () => {
  it("shows email and password and disables the button until both are filled", async () => {
    await renderApp("/login");

    const button = await screen.findByRole("button", { name: "Log in" });
    expect(button).toBeDisabled();
    await fireEvent.changeText(screen.getByLabelText("Email"), "ana@example.com");
    expect(button).toBeDisabled();
    await fireEvent.changeText(screen.getByLabelText("Password"), "correct horse battery");
    expect(button).toBeEnabled();
  });

  it.each([
    ["invalid_credentials", "Wrong email or password"],
    ["locked", "Too many attempts. Try again in 15 minutes."],
  ])("shows the error for %s", async (error, message) => {
    mockApi.login.mockResolvedValue({ ok: false, error });
    await renderApp("/login");

    await fireEvent.changeText(await screen.findByLabelText("Email"), "ana@example.com");
    await fireEvent.changeText(screen.getByLabelText("Password"), "wrong password!");
    await fireEvent.press(screen.getByRole("button", { name: "Log in" }));

    expect(await screen.findByText(message)).toBeOnTheScreen();
    expect(mockApi.login).toHaveBeenCalledWith("ana@example.com", "wrong password!");
  });
});

describe("login TOTP", () => {
  it("auto-submits 6 digits and signs in", async () => {
    mockApi.loginTotp.mockResolvedValue({ ok: true, value: tokens });
    await goToTotp();

    const field = screen.getByLabelText("6-digit code");
    await fireEvent.changeText(field, "12345");
    expect(mockApi.loginTotp).not.toHaveBeenCalled();
    await fireEvent.changeText(field, "123456");

    await waitFor(() => expect(mockAuth.signIn).toHaveBeenCalledWith(tokens));
    expect(mockApi.loginTotp).toHaveBeenCalledWith({ mfaToken: "mfa-1", code: "123456" });
  });

  it("logs in with a recovery code from the link", async () => {
    mockApi.loginTotp.mockResolvedValue({ ok: true, value: tokens });
    await goToTotp();

    await fireEvent.press(screen.getByText("Use a recovery code"));
    await fireEvent.changeText(screen.getByLabelText("Recovery code"), "abcd-efgh");
    await fireEvent.press(screen.getByRole("button", { name: "Log in" }));

    await waitFor(() => expect(mockAuth.signIn).toHaveBeenCalledWith(tokens));
    expect(mockApi.loginTotp).toHaveBeenCalledWith({ mfaToken: "mfa-1", recoveryCode: "abcd-efgh" });
  });
});

describe("invite", () => {
  it("sets the password, confirms TOTP and shows the recovery codes", async () => {
    mockApi.acceptInvite.mockResolvedValue({
      ok: true,
      value: { otpauth_url: "otpauth://totp/Money%20Tracker:ana", secret: "JBSWY3DPEHPK3PXP" },
    });
    mockApi.confirmInvite.mockResolvedValue({ ok: true, value: { ...tokens, recovery_codes: RECOVERY_CODES } });
    await renderApp("/invite?token=invite-1");

    // Step 1: the password, at least 12 characters, typed twice.
    const next = await screen.findByRole("button", { name: "Continue" });
    await fireEvent.changeText(screen.getByLabelText("Password"), "short");
    await fireEvent.changeText(screen.getByLabelText("Repeat password"), "short");
    expect(next).toBeDisabled();
    await fireEvent.changeText(screen.getByLabelText("Password"), "long enough password");
    await fireEvent.changeText(screen.getByLabelText("Repeat password"), "long enough passwort");
    expect(next).toBeDisabled();
    await fireEvent.changeText(screen.getByLabelText("Repeat password"), "long enough password");
    expect(next).toBeEnabled();
    await fireEvent.press(next);
    expect(mockApi.acceptInvite).toHaveBeenCalledWith("invite-1", "long enough password");

    // Step 2: the QR code, the secret with a copy button and the code field.
    expect(await screen.findByTestId("totp-qr")).toHaveTextContent("otpauth://totp/Money%20Tracker:ana");
    expect(screen.getByText("JBSWY3DPEHPK3PXP")).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole("button", { name: "Copy secret" }));
    expect(Clipboard.setStringAsync).toHaveBeenCalledWith("JBSWY3DPEHPK3PXP");
    await fireEvent.changeText(screen.getByLabelText("6-digit code"), "654321");
    await waitFor(() => expect(mockApi.confirmInvite).toHaveBeenCalledWith("invite-1", "654321"));

    // Step 3: the recovery codes.
    expect(await screen.findByText("code-0")).toBeOnTheScreen();
    expect(screen.getByText("code-9")).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole("button", { name: "Copy all" }));
    expect(Clipboard.setStringAsync).toHaveBeenLastCalledWith(RECOVERY_CODES.join("\n"));

    const finish = screen.getByRole("button", { name: "Continue" });
    expect(finish).toBeDisabled();
    expect(mockAuth.signIn).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByRole("checkbox", { name: "I saved these codes" }));
    expect(finish).toBeEnabled();
    await fireEvent.press(finish);
    expect(mockAuth.signIn).toHaveBeenCalledWith({ ...tokens, recovery_codes: RECOVERY_CODES });
  });
});

describe("root gate", () => {
  it("sends signedOut users to login", async () => {
    const router = await renderApp("/spending");

    expect(await screen.findByLabelText("Email")).toBeOnTheScreen();
    expect(router.getPathname()).toBe("/login");
    expect(screen.queryByText("Spending page")).toBeNull();
  });

  it("shows the login as a modal over the app in reauthRequired", async () => {
    mockAuth.status = "reauthRequired";
    mockAuth.userId = "user-1";
    const router = await renderApp("/spending");

    expect(await screen.findByText("Spending page")).toBeOnTheScreen();
    expect(screen.getByLabelText("Email")).toBeOnTheScreen();
    expect(router.getPathname()).toBe("/spending");
  });

  it("connects the database when signed in", async () => {
    mockAuth.status = "signedIn";
    mockAuth.userId = "user-1";
    await renderApp("/spending");

    expect(await screen.findByText("Spending page")).toBeOnTheScreen();
    await act(async () => {});
    expect(mockDb.connect).toHaveBeenCalledTimes(1);
    expect(screen.queryByLabelText("Email")).toBeNull();
    expect(screen.queryByText("Needs attention")).toBeNull();
  });

  it("shows the Log in again banner, which opens the login again after a close", async () => {
    mockAuth.status = "reauthRequired";
    mockAuth.userId = "user-1";
    await renderApp("/spending");

    expect(await screen.findByText("Your session has ended. Your changes stay on this device until you log in.")).toBeOnTheScreen();
    // The swipe down of the page sheet calls onRequestClose of the modal.
    let modal = screen.getByLabelText("Email").parent;
    while (modal && !modal.props.onRequestClose) modal = modal.parent;
    await act(async () => modal?.props.onRequestClose());
    expect(screen.queryByLabelText("Email")).toBeNull();

    await fireEvent.press(screen.getByRole("button", { name: "Log in" }));
    expect(screen.getByLabelText("Email")).toBeOnTheScreen();
  });

  it("shows the Needs attention banner, which opens the sync problems", async () => {
    mockAuth.status = "signedIn";
    mockAuth.userId = "user-1";
    mockProblemCount = 2;
    const router = await renderApp("/spending");

    expect(await screen.findByText("Needs attention")).toBeOnTheScreen();
    expect(screen.getByText("The server did not accept 2 changes.")).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole("button", { name: "Review" }));

    expect(await screen.findByText("Sync problems page")).toBeOnTheScreen();
    expect(router.getPathname()).toBe("/sync-problems");
  });
});
