//
// A documentation page is prose, and prose is not usually worth asserting on.
// This one is different in a specific way: it is the page a reader consults to
// find out what the product *promises*, and several of those promises are the
// reason the rest of the console is built the way it is. If the page stopped
// stating one, the interface would still work and a reader would have lost the
// only statement of the rule.
//
// So the assertions below are the promises, not the wording: that a number is
// never re-derived in the interface, that an unavailable measurement is never
// turned into a zero, that absence is stated rather than converted, that no model
// explains a result, that a comparison report is not persisted, and that a
// credential never reaches the browser.
//
// It also asserts the page carries no credential-shaped string of its own, which
// is the one way a documentation page can leak.

import { describe, expect, it } from 'vitest';
import DocsPage from '@/app/(dashboard)/dashboard/docs/page';
import { render } from './render';

describe('the documentation page', () => {
  it('states the rule that the interface re-implements no engine', async () => {
    const view = await render(<DocsPage />);

    expect(view.has('How Agent Twin works')).toBe(true);
    expect(view.has('produced by a server-side engine and displayed unchanged')).toBe(true);
    expect(view.has('does not re-implement an evaluation formula')).toBe(true);
    // The reason it is a rule and not a preference.
    expect(view.has('There is exactly one implementation of each')).toBe(true);
    await view.unmount();
  });

  it('states that an unavailable measurement is never a zero', async () => {
    const view = await render(<DocsPage />);

    expect(view.has('reports it as unavailable, with a reason')).toBe(true);
    expect(view.has('never converts an unavailable measurement into a zero')).toBe(true);
    expect(view.has('a zero is a claim and an absence is not')).toBe(true);
    await view.unmount();
  });

  it('states that the interface never asks a model to explain a result', async () => {
    const view = await render(<DocsPage />);

    expect(view.has('Only conclusions the engine returns are displayed')).toBe(true);
    expect(view.has('never asks a model to explain a result')).toBe(true);
    // And why: a model's explanation is not evidence about the agent under test.
    expect(view.has('not evidence about the agent under test')).toBe(true);
    await view.unmount();
  });

  it('states that the verdict has three outcomes and that insufficient evidence is one of them', async () => {
    const view = await render(<DocsPage />);

    expect(view.has('exactly one of three outcomes')).toBe(true);
    expect(view.has('the agents tie')).toBe(true);
    expect(view.has('“Insufficient evidence” is a real result, not an error')).toBe(true);
    await view.unmount();
  });

  it('states that a comparison report is not persisted, and why', async () => {
    const view = await render(<DocsPage />);

    expect(view.has('A comparison report is not persisted')).toBe(true);
    expect(view.has('a stored copy could only drift from its own evidence')).toBe(true);
    // The consequence a reader has to know before they go looking for a permalink.
    expect(view.has('lives in the browser session that produced it')).toBe(true);
    // And the absence of an agent registry, stated rather than implied.
    expect(view.has('There is no agent registry')).toBe(true);
    await view.unmount();
  });

  it('states that credentials never reach the browser', async () => {
    const view = await render(<DocsPage />);
    const text = view.text();

    expect(text).toContain('Provider credentials are read from the server environment only');
    expect(text).toContain('the browser never receives them');
    // The page makes that claim, so it must not be the exception to it.
    expect(text).not.toMatch(/sk-[A-Za-z0-9]/);
    expect(text).not.toMatch(/authorization|bearer/i);
    expect(text).not.toContain('OPENROUTER_API_KEY');
    expect(text).not.toContain('BEDROCK_MODEL_ID');
    await view.unmount();
  });

  it('states how a run reports itself, without promising progress it cannot know', async () => {
    const view = await render(<DocsPage />);

    expect(view.has('never by a progress bar that moves on a timer')).toBe(true);
    expect(view.has('it is shown as not started, because that is what is true')).toBe(true);
    await view.unmount();
  });

  it('offers a way into every destination it describes', async () => {
    const view = await render(<DocsPage />);
    const hrefs = view.all('a').map((anchor) => anchor.getAttribute('href'));

    for (const href of [
      '/dashboard/tests',
      '/dashboard/benchmarks',
      '/dashboard/agents',
      '/dashboard/simulations',
    ])
      expect(hrefs).toContain(href);
    await view.unmount();
  });

  it('gives every section an anchor, so a section can be linked to', async () => {
    const view = await render(<DocsPage />);
    const hrefs = view.all('a').map((anchor) => anchor.getAttribute('href'));
    const anchored = hrefs.filter((href) => href?.startsWith('#'));

    // One anchor per section, and each one resolves to a panel on the page.
    expect(anchored.length).toBeGreaterThanOrEqual(9);
    for (const href of anchored) expect(view.one(`[id="${href?.slice(1)}"]`)).not.toBeNull();
    await view.unmount();
  });
});
