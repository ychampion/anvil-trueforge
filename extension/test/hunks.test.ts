import { test, expect } from 'bun:test';
import { computeHunks, applyHunks } from '../src/review/hunks';

const a = 'l1\nl2\nl3\nl4\nl5\nl6\n';
const b = 'l1\nX2\nl3\nl4\nl5\nY6\nZ7\n';
test('hunks split and partial apply', () => {
  const h = computeHunks(a, b);
  expect(h.length).toBe(2);
  expect(applyHunks(a, h, [true, true])).toBe(b);
  expect(applyHunks(a, h, [false, false])).toBe(a);
  expect(applyHunks(a, h, [true, false])).toBe('l1\nX2\nl3\nl4\nl5\nl6\n');
  expect(applyHunks(a, h, [false, true])).toBe('l1\nl2\nl3\nl4\nl5\nY6\nZ7\n');
});
test('new file and no trailing newline', () => {
  const h = computeHunks('', 'a\nb');
  expect(applyHunks('', h, [true])).toBe('a\nb');
  const h2 = computeHunks('x\ny', 'x\nz');
  expect(applyHunks('x\ny', h2, [true])).toBe('x\nz');
  expect(applyHunks('x\ny', h2, [false])).toBe('x\ny');
});
