import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { Fragment, useMemo, type ReactNode } from "react";
import { Linking, Platform, ScrollView, Text, View } from "react-native";

type Theme = PluginSurfaceProps["theme"];

type Block =
  | { kind: "heading"; level: number; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "code"; text: string }
  | { kind: "quote"; text: string }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "rule" };

const MONOSPACE = Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" });
const HEADING_SIZES = [22, 19, 17, 16, 15, 14];
/** Inline spans: code, bold, italic, strikethrough, links. Order matters: code first. */
const INLINE_PATTERN =
  /(`[^`\n]+`)|(\*\*[^*\n]+\*\*|__[^_\n]+__)|(\*[^*\s][^*\n]*\*|_[^_\s][^_\n]*_)|(~~[^~\n]+~~)|(\[[^\]\n]+\]\([^)\s]+\))/g;

/** Block-level Markdown the agents write: headings, lists, quotes, fences, rules, paragraphs. */
function parseBlocks(source: string): Block[] {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  const flushParagraph = () => {
    if (paragraph.length) blocks.push({ kind: "paragraph", text: paragraph.join("\n") });
    paragraph = [];
  };
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const fence = /^\s*(```|~~~)/.exec(line);
    if (fence) {
      flushParagraph();
      const code: string[] = [];
      for (index++; index < lines.length && !lines[index].trimStart().startsWith(fence[1]); index++) {
        code.push(lines[index]);
      }
      blocks.push({ kind: "code", text: code.join("\n") });
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph();
      blocks.push({ kind: "heading", level: heading[1].length, text: heading[2] });
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flushParagraph();
      blocks.push({ kind: "rule" });
      continue;
    }
    if (/^\s*>/.test(line)) {
      flushParagraph();
      const quote: string[] = [];
      for (; index < lines.length && /^\s*>/.test(lines[index]); index++) {
        quote.push(lines[index].replace(/^\s*>\s?/, ""));
      }
      index--;
      blocks.push({ kind: "quote", text: quote.join("\n") });
      continue;
    }
    const listItem = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (listItem) {
      flushParagraph();
      const ordered = /\d/.test(listItem[1]);
      const items: string[] = [];
      for (; index < lines.length; index++) {
        const item = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(lines[index]);
        if (item && /\d/.test(item[1]) === ordered) items.push(item[2]);
        else if (items.length && /^\s{2,}\S/.test(lines[index])) items[items.length - 1] += `\n${lines[index].trim()}`;
        else break;
      }
      index--;
      blocks.push({ kind: "list", ordered, items });
      continue;
    }
    if (line.trim() === "") flushParagraph();
    else paragraph.push(line);
  }
  flushParagraph();
  return blocks;
}

function renderInline(text: string, theme: Theme): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(INLINE_PATTERN)) {
    const index = match.index ?? 0;
    if (index > last) nodes.push(text.slice(last, index));
    const [token, code, bold, italic, strike, link] = match;
    const key = `${index}`;
    if (code) {
      nodes.push(
        <Text key={key} style={{ fontFamily: MONOSPACE, backgroundColor: theme.colors.surface2 }}>
          {token.slice(1, -1)}
        </Text>,
      );
    } else if (bold) {
      nodes.push(
        <Text key={key} style={{ fontWeight: "700" }}>
          {renderInline(token.slice(2, -2), theme)}
        </Text>,
      );
    } else if (italic) {
      nodes.push(
        <Text key={key} style={{ fontStyle: "italic" }}>
          {renderInline(token.slice(1, -1), theme)}
        </Text>,
      );
    } else if (strike) {
      nodes.push(
        <Text key={key} style={{ textDecorationLine: "line-through" }}>
          {token.slice(2, -2)}
        </Text>,
      );
    } else if (link) {
      const [, label, url] = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(token) ?? [];
      nodes.push(
        <Text
          key={key}
          accessibilityRole="link"
          style={{ color: theme.colors.accent, textDecorationLine: "underline" }}
          onPress={() => {
            if (/^https?:\/\//.test(url ?? "")) void Linking.openURL(url!);
          }}
        >
          {label}
        </Text>,
      );
    }
    last = index + token.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

export function Markdown({ source, theme }: { source: string; theme: Theme }) {
  const blocks = useMemo(() => parseBlocks(source), [source]);
  const text = { color: theme.colors.foreground, fontSize: 15, lineHeight: 22 };
  return (
    <View style={{ gap: 10 }}>
      {blocks.map((block, index) => {
        switch (block.kind) {
          case "heading":
            return (
              <Text
                key={index}
                selectable
                style={{ ...text, fontWeight: "700", fontSize: HEADING_SIZES[block.level - 1], lineHeight: undefined }}
              >
                {renderInline(block.text, theme)}
              </Text>
            );
          case "paragraph":
            return (
              <Text key={index} selectable style={text}>
                {renderInline(block.text, theme)}
              </Text>
            );
          case "code":
            return (
              <ScrollView
                key={index}
                horizontal
                style={{ backgroundColor: theme.colors.surface2, borderRadius: 6 }}
                contentContainerStyle={{ padding: 10 }}
              >
                <Text selectable style={{ color: theme.colors.foreground, fontFamily: MONOSPACE, fontSize: 13 }}>
                  {block.text}
                </Text>
              </ScrollView>
            );
          case "quote":
            return (
              <View
                key={index}
                style={{ borderLeftWidth: 3, borderLeftColor: theme.colors.border, paddingLeft: 10 }}
              >
                <Text selectable style={{ ...text, color: theme.colors.foregroundMuted }}>
                  {renderInline(block.text, theme)}
                </Text>
              </View>
            );
          case "list":
            return (
              <View key={index} style={{ gap: 4 }}>
                {block.items.map((item, itemIndex) => (
                  <View key={itemIndex} style={{ flexDirection: "row", gap: 8 }}>
                    <Text style={{ ...text, color: theme.colors.foregroundMuted }}>
                      {block.ordered ? `${itemIndex + 1}.` : "•"}
                    </Text>
                    <Text selectable style={{ ...text, flex: 1 }}>
                      {renderInline(item, theme)}
                    </Text>
                  </View>
                ))}
              </View>
            );
          case "rule":
            return <View key={index} style={{ height: 1, backgroundColor: theme.colors.border }} />;
          default:
            return <Fragment key={index} />;
        }
      })}
    </View>
  );
}
