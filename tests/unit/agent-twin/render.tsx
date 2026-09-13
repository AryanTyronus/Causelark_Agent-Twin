// @polsia:user-owned — a dependency-free renderer for the Agent Twin UI tests.
//
// The console's components are the product the user actually touches, so they
// are tested by rendering them — not by asserting on helper functions beside
// them. That normally means pulling in a testing library; this deployment's
// dependency set deliberately does not include one, and adding a second React
// renderer to the build to test the first would be a poor trade.
//
// So this is the smallest thing that does the job: `react-dom/client` plus
// React's own `act`, and a handful of query helpers over the resulting DOM.
// Queries are text-based on purpose. A test that asserts "the verdict says
// insufficient evidence" is a statement about what a reader sees; a test that
// asserts on a class name is a statement about how it was styled.

import { act, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';

// React only batches updates inside `act` when it is told it is in a test
// environment. Without this, effects that resolve a promise after render warn
// and the assertions run against a half-settled tree.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom implements neither of these, and Radix's Select reads both when its
// trigger is rendered or focused. They are stubbed to the smallest behaviour
// that keeps a component from throwing — not to simulate a pointer device.
if (!('ResizeObserver' in globalThis)) {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
if (typeof Element !== 'undefined' && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = function scrollIntoView() {};
}

export interface Rendered {
  /** The container the tree was mounted into. */
  container: HTMLElement;
  /** Every visible word in the tree, whitespace-collapsed. */
  text: () => string;
  /** Whether `needle` appears in the rendered text. */
  has: (needle: string) => boolean;
  /** Every element matching a selector. */
  all: (selector: string) => HTMLElement[];
  /** The first element matching a selector, or `null`. */
  one: (selector: string) => HTMLElement | null;
  /** A button, link or input by its accessible name, or `null`. */
  control: (name: string) => HTMLElement | null;
  /** Click a control and let React settle. */
  click: (element: HTMLElement) => Promise<void>;
  /** Type into an input and let React settle. */
  type: (element: HTMLElement, value: string) => Promise<void>;
  /** Let pending promises and effects settle. */
  settle: () => Promise<void>;
  /** Unmount and remove the container. */
  unmount: () => Promise<void>;
}

/**
 * Mount a component and return queries over it.
 *
 * The first `act` covers the mount and its effects; a second flush covers the
 * first await inside those effects, which is where a fetch settles. Anything
 * later is the test's to await — `settle()` for a promise, `click()` for a
 * handler — so a test never has to guess how many flushes a tree needs.
 */
export async function render(element: ReactElement): Promise<Rendered> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(element);
  });
  await act(async () => {});

  const text = () => (container.textContent ?? '').replace(/\s+/g, ' ').trim();

  const settle = async () => {
    await act(async () => {});
    await act(async () => {});
  };

  /**
   * Whether a phrase appears in the tree.
   *
   * Both sides are whitespace-collapsed, because JSX splits a sentence across
   * text nodes wherever it is wrapped: a test that asserted on a sentence the
   * way it is written in the source would fail on the wrapping rather than on
   * the content.
   */
  const has = (needle: string) => text().includes(needle.replace(/\s+/g, ' ').trim());

  const control = (name: string): HTMLElement | null => {
    const candidates = container.querySelectorAll<HTMLElement>(
      'button, a, input, select, textarea',
    );
    for (const candidate of candidates) {
      const label =
        candidate.getAttribute('aria-label') ??
        candidate.textContent ??
        candidate.getAttribute('placeholder') ??
        '';
      if (label.replace(/\s+/g, ' ').trim().toLowerCase().includes(name.toLowerCase()))
        return candidate;
    }
    return null;
  };

  return {
    container,
    text,
    has,
    all: (selector: string) => [...container.querySelectorAll<HTMLElement>(selector)],
    one: (selector: string) => container.querySelector<HTMLElement>(selector),
    control,
    click: async (target: HTMLElement) => {
      await act(async () => {
        target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      });
      await settle();
    },
    type: async (target: HTMLElement, value: string) => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value',
      )?.set;
      await act(async () => {
        setter?.call(target, value);
        target.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await settle();
    },
    settle,
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}
