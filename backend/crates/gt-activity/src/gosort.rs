//! A port of Go's `sort.Slice` (pattern-defeating quicksort, `sort/zsortfunc.go`).
//!
//! `sort.Slice` is not stable, but it is deterministic: for the same input order and the same
//! `less` function it always produces the same output. The analytics daily breakdown sorts
//! database rows with it, so ties (activities with equal hours) must come out in exactly Go's
//! order. Slices of up to 12 elements use insertion sort, which is stable.

/// Sorts `data` exactly like Go's `sort.Slice(data, less)`.
pub fn sort_slice<T>(data: &mut [T], less: impl Fn(&T, &T) -> bool) {
    let length = data.len();
    let limit = bits_len(length);
    let mut sorter = Sorter { data, less };
    sorter.pdqsort(0, length, limit);
}

/// Go `bits.Len`: the number of bits needed to represent `x` (0 for 0).
fn bits_len(x: usize) -> u32 {
    usize::BITS - x.leading_zeros()
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum SortedHint {
    Unknown,
    Increasing,
    Decreasing,
}

/// Go's `xorshift` pseudo-random generator seeded with the slice length.
struct XorShift(u64);

impl XorShift {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 17;
        self.0 ^= self.0 << 5;
        self.0
    }
}

struct Sorter<'a, T, F> {
    data: &'a mut [T],
    less: F,
}

impl<T, F: Fn(&T, &T) -> bool> Sorter<'_, T, F> {
    fn less(&self, i: usize, j: usize) -> bool {
        (self.less)(&self.data[i], &self.data[j])
    }

    fn swap(&mut self, i: usize, j: usize) {
        self.data.swap(i, j);
    }

    fn insertion_sort(&mut self, a: usize, b: usize) {
        for i in a + 1..b {
            let mut j = i;
            while j > a && self.less(j, j - 1) {
                self.swap(j, j - 1);
                j -= 1;
            }
        }
    }

    fn sift_down(&mut self, lo: usize, hi: usize, first: usize) {
        let mut root = lo;
        loop {
            let mut child = 2 * root + 1;
            if child >= hi {
                return;
            }
            if child + 1 < hi && self.less(first + child, first + child + 1) {
                child += 1;
            }
            if !self.less(first + root, first + child) {
                return;
            }
            self.swap(first + root, first + child);
            root = child;
        }
    }

    fn heap_sort(&mut self, a: usize, b: usize) {
        let first = a;
        let hi = b - a;
        for i in (0..=(hi - 1) / 2).rev() {
            self.sift_down(i, hi, first);
        }
        for i in (0..hi).rev() {
            self.swap(first, first + i);
            self.sift_down(0, i, first);
        }
    }

    fn pdqsort(&mut self, mut a: usize, mut b: usize, mut limit: u32) {
        const MAX_INSERTION: usize = 12;
        let mut was_balanced = true;
        let mut was_partitioned = true;

        loop {
            let length = b - a;
            if length <= MAX_INSERTION {
                self.insertion_sort(a, b);
                return;
            }
            if limit == 0 {
                self.heap_sort(a, b);
                return;
            }
            if !was_balanced {
                self.break_patterns(a, b);
                limit -= 1;
            }

            let (mut pivot, mut hint) = self.choose_pivot(a, b);
            if hint == SortedHint::Decreasing {
                self.reverse_range(a, b);
                pivot = (b - 1) - (pivot - a);
                hint = SortedHint::Increasing;
            }

            if was_balanced && was_partitioned && hint == SortedHint::Increasing && self.partial_insertion_sort(a, b) {
                return;
            }

            if a > 0 && !self.less(a - 1, pivot) {
                a = self.partition_equal(a, b, pivot);
                continue;
            }

            let (mid, already_partitioned) = self.partition(a, b, pivot);
            was_partitioned = already_partitioned;

            let (left_len, right_len) = (mid - a, b - mid);
            let balance_threshold = length / 8;
            if left_len < right_len {
                was_balanced = left_len >= balance_threshold;
                self.pdqsort(a, mid, limit);
                a = mid + 1;
            } else {
                was_balanced = right_len >= balance_threshold;
                self.pdqsort(mid + 1, b, limit);
                b = mid;
            }
        }
    }

    fn partition(&mut self, a: usize, b: usize, pivot: usize) -> (usize, bool) {
        self.swap(a, pivot);
        let (mut i, mut j) = (a + 1, b - 1);
        while i <= j && self.less(i, a) {
            i += 1;
        }
        while i <= j && !self.less(j, a) {
            j -= 1;
        }
        if i > j {
            self.swap(j, a);
            return (j, true);
        }
        self.swap(i, j);
        i += 1;
        j -= 1;
        loop {
            while i <= j && self.less(i, a) {
                i += 1;
            }
            while i <= j && !self.less(j, a) {
                j -= 1;
            }
            if i > j {
                break;
            }
            self.swap(i, j);
            i += 1;
            j -= 1;
        }
        self.swap(j, a);
        (j, false)
    }

    fn partition_equal(&mut self, a: usize, b: usize, pivot: usize) -> usize {
        self.swap(a, pivot);
        let (mut i, mut j) = (a + 1, b - 1);
        loop {
            while i <= j && !self.less(a, i) {
                i += 1;
            }
            while i <= j && self.less(a, j) {
                j -= 1;
            }
            if i > j {
                break;
            }
            self.swap(i, j);
            i += 1;
            j -= 1;
        }
        i
    }

    fn partial_insertion_sort(&mut self, a: usize, b: usize) -> bool {
        const MAX_STEPS: usize = 5;
        const SHORTEST_SHIFTING: usize = 50;
        let mut i = a + 1;
        for _ in 0..MAX_STEPS {
            while i < b && !self.less(i, i - 1) {
                i += 1;
            }
            if i == b {
                return true;
            }
            if b - a < SHORTEST_SHIFTING {
                return false;
            }
            self.swap(i, i - 1);
            // Go shifts down to index 1 of the whole slice, not to `a`.
            if i - a >= 2 {
                let mut j = i - 1;
                while j >= 1 {
                    if !self.less(j, j - 1) {
                        break;
                    }
                    self.swap(j, j - 1);
                    j -= 1;
                }
            }
            if b - i >= 2 {
                let mut j = i + 1;
                while j < b {
                    if !self.less(j, j - 1) {
                        break;
                    }
                    self.swap(j, j - 1);
                    j += 1;
                }
            }
        }
        false
    }

    fn break_patterns(&mut self, a: usize, b: usize) {
        let length = b - a;
        if length >= 8 {
            let mut random = XorShift(length as u64);
            let modulus = 1usize << bits_len(length);
            let middle = a + (length / 4) * 2;
            for idx in middle - 1..=middle + 1 {
                let mut other = (random.next() as usize) & (modulus - 1);
                if other >= length {
                    other -= length;
                }
                self.swap(idx, a + other);
            }
        }
    }

    fn choose_pivot(&mut self, a: usize, b: usize) -> (usize, SortedHint) {
        const SHORTEST_NINTHER: usize = 50;
        const MAX_SWAPS: usize = 4 * 3;

        let l = b - a;
        let mut swaps = 0;
        let mut i = a + l / 4;
        let mut j = a + l / 4 * 2;
        let mut k = a + l / 4 * 3;

        if l >= 8 {
            if l >= SHORTEST_NINTHER {
                i = self.median_adjacent(i, &mut swaps);
                j = self.median_adjacent(j, &mut swaps);
                k = self.median_adjacent(k, &mut swaps);
            }
            j = self.median(i, j, k, &mut swaps);
        }

        match swaps {
            0 => (j, SortedHint::Increasing),
            MAX_SWAPS => (j, SortedHint::Decreasing),
            _ => (j, SortedHint::Unknown),
        }
    }

    fn order2(&self, a: usize, b: usize, swaps: &mut usize) -> (usize, usize) {
        if self.less(b, a) {
            *swaps += 1;
            return (b, a);
        }
        (a, b)
    }

    fn median(&self, a: usize, b: usize, c: usize, swaps: &mut usize) -> usize {
        let (a, b) = self.order2(a, b, swaps);
        let (b, _c) = self.order2(b, c, swaps);
        let (_a, b) = self.order2(a, b, swaps);
        b
    }

    fn median_adjacent(&self, a: usize, swaps: &mut usize) -> usize {
        self.median(a - 1, a, a + 1, swaps)
    }

    fn reverse_range(&mut self, a: usize, b: usize) {
        let (mut i, mut j) = (a, b - 1);
        while i < j {
            self.swap(i, j);
            i += 1;
            j -= 1;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `(key, original index)` pairs sorted by key descending.
    fn sorted_indices(keys: &[u32]) -> Vec<usize> {
        let mut items: Vec<(u32, usize)> = keys.iter().copied().zip(0..).collect();
        sort_slice(&mut items, |a, b| a.0 > b.0);
        items.into_iter().map(|(_, i)| i).collect()
    }

    #[test]
    fn small_slices_are_stable() {
        assert_eq!(sorted_indices(&[1, 3, 1, 3, 2]), vec![1, 3, 4, 0, 2]);
        assert_eq!(sorted_indices(&[]), Vec::<usize>::new());
    }

    /// Expected orders printed by Go 1.22 for `sort.Slice(items, func(i, j int) bool { return
    /// items[i].key > items[j].key })` with `items[i].key = (i * 7) % m` over `n` items.
    #[test]
    fn large_slices_match_go() {
        let keys = |n: u32, m: u32| (0..n).map(|i| (i * 7) % m).collect::<Vec<_>>();
        let parse = |s: &str| s.split(' ').map(|v| v.parse::<usize>().unwrap()).collect::<Vec<_>>();
        assert_eq!(sorted_indices(&keys(13, 3)), parse("8 2 11 5 1 4 10 7 6 9 0 3 12"));
        assert_eq!(sorted_indices(&keys(21, 4)), parse("5 1 17 13 9 10 6 18 2 14 15 7 19 11 3 4 16 12 0 8 20"));
        assert_eq!(
            sorted_indices(&keys(60, 5)),
            parse(
                "12 37 2 57 47 22 52 7 32 17 27 42 14 29 24 39 59 9 34 19 49 44 54 4 31 36 26 1 56 21 6 51 46 11 41 \
                 16 33 48 38 23 58 18 13 43 3 28 53 8 10 35 50 0 30 20 5 55 45 25 40 15"
            )
        );
        assert_eq!(
            sorted_indices(&keys(200, 3)),
            parse(
                "68 197 2 194 191 5 188 185 8 182 179 11 176 173 14 170 167 17 164 161 20 158 155 23 152 149 26 146 \
                 143 29 140 137 32 134 131 35 128 125 38 122 119 41 116 113 44 110 107 47 104 101 50 98 95 53 92 89 \
                 56 86 83 59 80 77 62 74 71 65 100 133 199 1 70 64 196 73 193 4 76 61 190 79 187 7 82 58 184 85 181 \
                 10 88 55 178 91 175 13 94 52 172 97 169 67 16 49 166 103 163 19 106 46 160 109 157 22 112 43 154 \
                 115 151 25 118 40 148 121 145 28 124 37 142 127 139 31 130 34 136 99 102 135 132 129 138 36 30 141 \
                 126 123 144 39 27 147 120 117 150 42 24 153 114 111 156 45 21 159 108 105 162 48 18 165 33 0 168 51 \
                 15 171 96 93 174 54 12 177 90 87 180 57 9 183 84 81 186 60 6 189 78 75 192 63 3 195 72 69 198 66"
            )
        );
    }
}
