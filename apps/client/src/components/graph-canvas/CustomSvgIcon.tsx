import { createElement, type ReactNode } from 'react'

export const MAX_CUSTOM_SVG_LENGTH = 20_000

type SvgElementName = 'g' | 'path' | 'circle' | 'ellipse' | 'line' | 'polyline' | 'polygon' | 'rect'

interface ParsedSvgNode {
  tag: SvgElementName
  props: Record<string, string>
  children: ParsedSvgNode[]
}

interface ParsedCustomSvg {
  viewBox: string
  rootProps: Record<string, string>
  children: ParsedSvgNode[]
}

type ParseResult =
  | { value: ParsedCustomSvg; error: null }
  | { value: null; error: string }

const ALLOWED_ELEMENTS = new Set<SvgElementName>([
  'g',
  'path',
  'circle',
  'ellipse',
  'line',
  'polyline',
  'polygon',
  'rect',
])

const IGNORED_ELEMENTS = new Set(['title', 'desc', 'metadata'])

const ATTRIBUTE_PROPS: Record<string, string> = {
  d: 'd',
  fill: 'fill',
  stroke: 'stroke',
  'stroke-width': 'strokeWidth',
  'stroke-linecap': 'strokeLinecap',
  'stroke-linejoin': 'strokeLinejoin',
  'stroke-miterlimit': 'strokeMiterlimit',
  'stroke-dasharray': 'strokeDasharray',
  'stroke-dashoffset': 'strokeDashoffset',
  'fill-rule': 'fillRule',
  'clip-rule': 'clipRule',
  opacity: 'opacity',
  'fill-opacity': 'fillOpacity',
  'stroke-opacity': 'strokeOpacity',
  transform: 'transform',
  cx: 'cx',
  cy: 'cy',
  r: 'r',
  rx: 'rx',
  ry: 'ry',
  x: 'x',
  y: 'y',
  x1: 'x1',
  x2: 'x2',
  y1: 'y1',
  y2: 'y2',
  width: 'width',
  height: 'height',
  points: 'points',
  'vector-effect': 'vectorEffect',
}

const PAINT_ATTRIBUTES = new Set(['fill', 'stroke'])
const NUMERIC_VALUE = /^[+\-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+\-]?\d+)?(?:px)?$/i
const NUMBER_LIST = /^[\d\s,.+\-eE]+$/
const PATH_DATA = /^[\d\s,.+\-eEa-zA-Z]+$/
const TRANSFORM_VALUE = /^[\d\s,.+\-eEa-zA-Z()]+$/
const parseCache = new Map<string, ParseResult>()

function paintValue(value: string): string {
  const normalized = value.trim().toLowerCase()
  return normalized === 'none' || normalized === 'transparent' ? 'none' : 'currentColor'
}

function safeAttributeValue(name: string, value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > 5_000) return null
  if (PAINT_ATTRIBUTES.has(name)) return paintValue(trimmed)
  if (name === 'd') return PATH_DATA.test(trimmed) ? trimmed : null
  if (name === 'points') return NUMBER_LIST.test(trimmed) ? trimmed : null
  if (name === 'transform') return TRANSFORM_VALUE.test(trimmed) ? trimmed : null
  if (name === 'vector-effect') return trimmed === 'non-scaling-stroke' ? trimmed : null
  if (name === 'fill-rule' || name === 'clip-rule') {
    return trimmed === 'evenodd' || trimmed === 'nonzero' ? trimmed : null
  }
  if (name === 'stroke-linecap') {
    return ['butt', 'round', 'square'].includes(trimmed) ? trimmed : null
  }
  if (name === 'stroke-linejoin') {
    return ['arcs', 'bevel', 'miter', 'miter-clip', 'round'].includes(trimmed) ? trimmed : null
  }
  if (name === 'stroke-dasharray') return trimmed === 'none' || NUMBER_LIST.test(trimmed) ? trimmed : null
  return NUMERIC_VALUE.test(trimmed) ? trimmed.replace(/px$/i, '') : null
}

function presentationProps(element: Element): Record<string, string> {
  const props: Record<string, string> = {}

  for (const attribute of element.attributes) {
    const name = attribute.name.toLowerCase()
    if (name.startsWith('on') || name === 'href' || name === 'xlink:href') continue

    if (name === 'style') {
      for (const declaration of attribute.value.split(';')) {
        const separator = declaration.indexOf(':')
        if (separator === -1) continue
        const styleName = declaration.slice(0, separator).trim().toLowerCase()
        const propName = ATTRIBUTE_PROPS[styleName]
        if (!propName) continue
        const value = safeAttributeValue(styleName, declaration.slice(separator + 1))
        if (value !== null) props[propName] = value
      }
      continue
    }

    const propName = ATTRIBUTE_PROPS[name]
    if (!propName) continue
    const value = safeAttributeValue(name, attribute.value)
    if (value !== null) props[propName] = value
  }

  return props
}

function canonicalViewBox(root: Element): string {
  const source = root.getAttribute('viewBox')
  if (source) {
    const numbers = source.trim().split(/[\s,]+/).map(Number)
    if (numbers.length === 4 && numbers.every(Number.isFinite) && numbers[2]! > 0 && numbers[3]! > 0) {
      return numbers.join(' ')
    }
  }

  const width = Number.parseFloat(root.getAttribute('width') ?? '')
  const height = Number.parseFloat(root.getAttribute('height') ?? '')
  if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
    return `0 0 ${width} ${height}`
  }
  return '0 0 24 24'
}

function parseCustomSvg(source: string): ParseResult {
  const cached = parseCache.get(source)
  if (cached) return cached

  let result: ParseResult
  if (!source.trim()) {
    result = { value: null, error: 'Paste a complete <svg> element.' }
  } else if (source.length > MAX_CUSTOM_SVG_LENGTH) {
    result = { value: null, error: `SVG must be smaller than ${MAX_CUSTOM_SVG_LENGTH.toLocaleString()} characters.` }
  } else if (typeof DOMParser === 'undefined') {
    result = { value: null, error: 'SVG parsing is unavailable in this environment.' }
  } else {
    try {
      const document = new DOMParser().parseFromString(source, 'image/svg+xml')
      const parserError = document.querySelector('parsererror')
      const root = document.documentElement
      if (parserError || root.localName.toLowerCase() !== 'svg') {
        result = { value: null, error: 'Paste one valid <svg> element.' }
      } else {
        let elementCount = 0
        let parseError: string | null = null

        const parseChildren = (parent: Element): ParsedSvgNode[] => {
          const children: ParsedSvgNode[] = []
          for (const child of parent.children) {
            const tag = child.localName.toLowerCase()
            if (IGNORED_ELEMENTS.has(tag)) continue
            if (!ALLOWED_ELEMENTS.has(tag as SvgElementName)) {
              parseError = `Unsupported SVG element: <${tag}>.`
              return []
            }
            elementCount += 1
            if (elementCount > 250) {
              parseError = 'SVG contains too many elements (maximum 250).'
              return []
            }
            const nestedChildren = parseChildren(child)
            if (parseError) return []
            children.push({
              tag: tag as SvgElementName,
              props: presentationProps(child),
              children: nestedChildren,
            })
          }
          return children
        }

        const children = parseChildren(root)
        if (parseError) {
          result = { value: null, error: parseError }
        } else if (children.length === 0) {
          result = { value: null, error: 'SVG does not contain a supported shape.' }
        } else {
          result = {
            value: {
              viewBox: canonicalViewBox(root),
              rootProps: presentationProps(root),
              children,
            },
            error: null,
          }
        }
      }
    } catch {
      result = { value: null, error: 'Could not parse this SVG.' }
    }
  }

  if (parseCache.size >= 100) parseCache.clear()
  parseCache.set(source, result)
  return result
}

export function customSvgIconError(source: string): string | null {
  return parseCustomSvg(source).error
}

function renderNode(node: ParsedSvgNode, key: string): ReactNode {
  return createElement(
    node.tag,
    { ...node.props, key },
    node.children.map((child, index) => renderNode(child, `${key}-${index}`)),
  )
}

export function CustomSvgIcon({ source, color, size = 13 }: { source: string; color: string; size?: number }) {
  const parsed = parseCustomSvg(source)
  if (!parsed.value) return null

  return (
    <svg
      fill="currentColor"
      stroke="none"
      {...parsed.value.rootProps}
      aria-hidden="true"
      focusable="false"
      x={-size / 2}
      y={-size / 2}
      width={size}
      height={size}
      viewBox={parsed.value.viewBox}
      style={{ color, overflow: 'visible' }}
    >
      {parsed.value.children.map((node, index) => renderNode(node, `custom-svg-${index}`))}
    </svg>
  )
}
