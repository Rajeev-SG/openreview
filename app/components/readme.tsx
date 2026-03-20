"use client";

import { cjk } from "@streamdown/cjk";
import { code } from "@streamdown/code";
import { math } from "@streamdown/math";
import { mermaid } from "@streamdown/mermaid";
import { Streamdown } from "streamdown";

import "streamdown/styles.css";

const plugins = { cjk, code, math, mermaid };

export const Readme = ({ content }: { content: string }) => (
  <Streamdown mode="static" plugins={plugins} linkSafety={{ enabled: false }}>
    {content}
  </Streamdown>
);
