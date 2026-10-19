import { readFileSync } from "fs";
import { join } from "path";
import { render, screen } from "@testing-library/react-native";

import { CategoryIcon, categoryIconKeys, categoryIcons } from "./categoryIcons";

const expectedKeys = [
  "fork", "cart", "groceries", "music", "bus", "flame", "tax", "gift", "key",
  "calculator", "book", "tag", "piggy", "coins", "car", "home", "health",
  "phone", "coffee", "plane", "baby", "shirt", "sport", "pet",
];

describe("category icon registry", () => {
  it("has exactly the agreed keys", () => {
    expect([...categoryIconKeys].sort()).toEqual([...expectedKeys].sort());
    expect(Object.keys(categoryIcons).sort()).toEqual([...expectedKeys].sort());
  });

  it("gives each key an English label", () => {
    for (const key of expectedKeys) {
      const label = categoryIcons[key as keyof typeof categoryIcons].label;
      expect(label).toMatch(/^[A-Z][A-Za-z ]+$/);
    }
  });

  it.each(expectedKeys)("renders %s in filled and outline style", async (key) => {
    const icon = key as keyof typeof categoryIcons;
    const { label } = categoryIcons[icon];

    await render(<CategoryIcon icon={icon} variant="filled" />);
    expect(screen.getByLabelText(label)).toBeTruthy();
    expect(screen.getByTestId(`category-icon-${key}-filled`)).toBeTruthy();

    await render(<CategoryIcon icon={icon} variant="outline" />);
    expect(screen.getByLabelText(label)).toBeTruthy();
    expect(screen.getByTestId(`category-icon-${key}-outline`)).toBeTruthy();
  });

  it("covers every icon of the default categories in the API seed", () => {
    const seed = readFileSync(join(__dirname, "../../../../api/internal/users/seed.go"), "utf8");
    const used = [...seed.matchAll(/\{"(?:expense|income)", "[^"]+", "([a-z]+)", "#[0-9a-f]{6}"\}/g)].map(
      (m) => m[1],
    );
    expect(used.length).toBeGreaterThan(0);
    for (const icon of used) {
      expect(expectedKeys).toContain(icon);
    }
  });
});
