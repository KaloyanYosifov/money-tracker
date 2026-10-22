import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { TextInput } from "react-native";

import type { LayoutMode } from "../../hooks/useLayoutMode";
import { useBottomInset } from "./bottomInset";
import { DeskScreen } from "./DeskScreen";

let mockMode: LayoutMode = "tabs";
jest.mock("../../hooks/useLayoutMode", () => ({ useLayoutMode: () => mockMode }));
let mockInsets = { top: 0, right: 0, bottom: 0, left: 0 };
jest.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => mockInsets }));
jest.mock("../screens/manage", () => ({
  useScreenSettings: () => ({ settings: undefined, theme: jest.requireActual("../theme").colors.light }),
}));

function Form() {
  // The scroll content of a form takes the bottom inset as padding.
  return <TextInput accessibilityLabel="Note" defaultValue="" style={{ paddingBottom: useBottomInset() }} />;
}

describe("DeskScreen", () => {
  beforeEach(() => {
    mockMode = "tabs";
    mockInsets = { top: 0, right: 0, bottom: 0, left: 0 };
  });

  it("keeps the phone screen clear of the notch and gives the home indicator inset to the content", async () => {
    mockInsets = { top: 0, right: 62, bottom: 21, left: 62 };
    await render(
      <DeskScreen>
        <Form />
      </DeskScreen>,
    );
    const screenView = screen.getByLabelText("Note").parent?.parent;
    const outer = Object.assign({}, ...(screenView?.props.style as object[]));
    expect(outer).toMatchObject({ paddingLeft: 62, paddingRight: 62 });
    // Padding outside the scroll view would clip the last row.
    expect(outer).not.toHaveProperty("paddingBottom");
    expect(screen.getByLabelText("Note").props.style).toEqual({ paddingBottom: 21 });
  });

  it("gives no bottom inset to the card of the sidebar layout", async () => {
    mockMode = "sidebar";
    mockInsets = { top: 0, right: 0, bottom: 21, left: 0 };
    await render(
      <DeskScreen>
        <Form />
      </DeskScreen>,
    );
    expect(screen.getByLabelText("Note").props.style).toEqual({ paddingBottom: 0 });
  });

  it("keeps the typed input when the layout changes between the phone and the sidebar layout", async () => {
    const view = await render(
      <DeskScreen>
        <Form />
      </DeskScreen>,
    );
    await fireEvent.changeText(screen.getByLabelText("Note"), "Lunch");
    const input = screen.getByLabelText("Note");

    for (const mode of ["sidebar", "tabs"] as const) {
      mockMode = mode;
      await act(async () =>
        view.rerender(
          <DeskScreen>
            <Form />
          </DeskScreen>,
        ),
      );
      // The same host instance means that React did not mount the form again.
      expect(screen.getByLabelText("Note")).toBe(input);
    }
  });
});
