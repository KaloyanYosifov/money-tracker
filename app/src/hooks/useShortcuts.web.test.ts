import { handleShortcut } from "./useShortcuts.web";

// The jest preset has no DOM. A small element class is enough for the tag and role checks.
class FakeElement {
  isContentEditable = false;
  constructor(public tagName: string) {}
  getAttribute(): string | null {
    return null;
  }
}
(globalThis as { HTMLElement?: unknown }).HTMLElement = FakeElement;

const element = (tag: string) => new FakeElement(tag.toUpperCase()) as unknown as HTMLElement;

type Modifiers = { metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean };

function press(key: string, target: HTMLElement, modifiers: Modifiers = {}): KeyboardEvent {
  return { key, target, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...modifiers } as unknown as KeyboardEvent;
}

describe("handleShortcut Enter", () => {
  it("saves from a single-line input", () => {
    const save = jest.fn();
    expect(handleShortcut(press("Enter", element("input")), { save })).toBe(true);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("types a new line in a multi-line field and does not save", () => {
    const save = jest.fn();
    expect(handleShortcut(press("Enter", element("textarea")), { save })).toBe(false);
    expect(save).not.toHaveBeenCalled();
  });

  it.each([{ metaKey: true }, { ctrlKey: true }])("saves with %o + Enter, also from a multi-line field", (modifier) => {
    const save = jest.fn();
    expect(handleShortcut(press("Enter", element("textarea"), modifier), { save })).toBe(true);
    expect(handleShortcut(press("Enter", element("input"), modifier), { save })).toBe(true);
    expect(save).toHaveBeenCalledTimes(2);
  });

  it("leaves Enter on a focused button to the button", () => {
    const save = jest.fn();
    expect(handleShortcut(press("Enter", element("button")), { save })).toBe(false);
    expect(save).not.toHaveBeenCalled();
  });

  it("does not use Cmd+Enter when the screen has no save", () => {
    expect(handleShortcut(press("Enter", element("textarea"), { metaKey: true }), {})).toBe(false);
  });
});
