---
title: Markdown showcase
date: 2026-10-14
tags: markdown, reference
---

A tour of the syntax this blog understands: CommonMark plus the
GitHub-flavoured extensions MD4C implements.

## Inline formatting

*Emphasis*, **strong**, ***both***, ~~strikethrough~~, `inline code`,
==highlight==, and a [link](https://commonmark.org). Bare URLs such as
https://github.com/mity/md4c become links automatically.

## Lists

1. First
2. Second
   - Nested bullet
   - Another one
3. Third

- [x] Task lists
- [ ] with checkboxes

## Code

```js
const md4c = await loadMd4c();
console.log(md4c.toHtml('# Hello'));
```

## Tables

| Feature        | Flag              | Default |
|:---------------|:------------------|:-------:|
| Tables         | `TABLES`          |   yes   |
| Strikethrough  | `STRIKETHROUGH`   |   yes   |
| Wiki links     | `WIKILINKS`       |   yes   |
| Underline      | `UNDERLINE`       |   no    |

## Quotes and admonitions

> Markdown is intended to be as easy-to-read and easy-to-write as is
> feasible.

> [!NOTE]
> Admonitions use GitHub's `> [!NOTE]` syntax.

> [!WARNING]
> Anything uploaded to the public bucket can be read by anyone with its URL,
> so keep drafts on your own machine.

## Mathematics

Inline mathematics such as $e^{i\pi} + 1 = 0$ and display equations are
typeset with KaTeX, which is loaded only for posts that contain math:

$$
\hat{f}(\xi) = \int_{-\infty}^{\infty} f(x)\, e^{-2\pi i x \xi}\, dx
$$

The cost of parsing a document of $n$ bytes is $O(n)$ for typical input.

## Footnotes

MD4C supports footnotes[^1], and links between posts like [[Welcome]].

[^1]: Rendered at the bottom of the post, with a link back.

---

That's the tour.
