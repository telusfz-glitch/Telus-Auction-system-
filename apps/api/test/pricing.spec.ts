import { minNextBid, type Bracket } from '../src/bids/pricing';

describe('minNextBid — the single pricing rule shared by the bid engine and the lot table', () => {
  const c = (aed: number) => BigInt(Math.round(aed * 100));
  const brackets: Bracket[] = [
    { from: c(0), to: c(1000), margin: c(10) },
    { from: c(1000), to: c(5000), margin: c(25) },
  ];

  it('no bid yet: the starting price', () => {
    expect(minNextBid(null, c(750), c(5), brackets)).toBe(c(750));
  });
  it('adds the margin of the bracket that contains the current price (lower bound inclusive, upper exclusive)', () => {
    expect(minNextBid(c(999.99), c(1), c(5), brackets)).toBe(c(1009.99));
    expect(minNextBid(c(1000), c(1), c(5), brackets)).toBe(c(1025));
  });
  it('falls back to the lot increment above every bracket, or when the customer has no rule set', () => {
    expect(minNextBid(c(5000), c(1), c(5), brackets)).toBe(c(5005));
    expect(minNextBid(c(100), c(1), c(7.5), [])).toBe(c(107.5));
  });
});
