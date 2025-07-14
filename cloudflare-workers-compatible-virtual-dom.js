// Constants for node types (like DOM)
const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

class Node {
	constructor() {
		this.childNodes = [];
		this.parentNode = null;
		this.previousSibling = null;
		this.nextSibling = null;
	}

	get firstChild() {
		return this.childNodes[0] || null;
	}
	get lastChild() {
		return this.childNodes[this.childNodes.length - 1] || null;
	}

	get children() {
		// Only Element nodes
		return new NodeList(this.childNodes.filter((n) => n.nodeType === ELEMENT_NODE));
	}

	appendChild(node) {
		if (!(node instanceof Node)) throw new Error('Only Node instances can be appended');
		if (node.parentNode) node.parentNode.removeChild(node);

		const last = this.childNodes[this.childNodes.length - 1];
		if (last) {
			last.nextSibling = node;
			node.previousSibling = last;
		} else {
			node.previousSibling = null;
		}
		node.nextSibling = null;

		this.childNodes.push(node);
		node.parentNode = this;
		return node;
	}

	removeChild(node) {
		const idx = this.childNodes.indexOf(node);
		if (idx === -1) throw new Error('Node not found');

		// Fix siblings
		const prev = node.previousSibling;
		const next = node.nextSibling;
		if (prev) prev.nextSibling = next;
		if (next) next.previousSibling = prev;

		node.previousSibling = null;
		node.nextSibling = null;
		node.parentNode = null;

		this.childNodes.splice(idx, 1);
		return node;
	}

	insertBefore(newNode, referenceNode) {
		if (!(newNode instanceof Node)) throw new Error('Only Node instances can be inserted');
		const refIndex = this.childNodes.indexOf(referenceNode);
		if (refIndex === -1) throw new Error('Reference node not found');
		if (newNode.parentNode) newNode.parentNode.removeChild(newNode);

		// Fix siblings
		const prev = this.childNodes[refIndex - 1] || null;
		if (prev) prev.nextSibling = newNode;
		newNode.previousSibling = prev;
		newNode.nextSibling = referenceNode;
		referenceNode.previousSibling = newNode;

		this.childNodes.splice(refIndex, 0, newNode);
		newNode.parentNode = this;
		return newNode;
	}

	get nodeName() {
		return '#node';
	}

	get nodeType() {
		return 0;
	}

	toString() {
		if (typeof this.outerHTML === 'string') return this.outerHTML;
		if (this.childNodes.length) return this.childNodes.map((n) => n.toString()).join('');
		return '';
	}
}

// Live NodeList-like collection (read-only)
class NodeList {
	constructor(nodes) {
		this._nodes = nodes;
	}

	item(index) {
		return this._nodes[index] || null;
	}

	get length() {
		return this._nodes.length;
	}

	[Symbol.iterator]() {
		return this._nodes[Symbol.iterator]();
	}

	forEach(callback, thisArg) {
		this._nodes.forEach(callback, thisArg);
	}
}

// TextNode support for text content
class TextNode extends Node {
	constructor(text) {
		super();
		this.textContent = String(text);
	}

	get nodeName() {
		return '#text';
	}

	get nodeType() {
		return TEXT_NODE;
	}

	toString() {
		// Escape < & > & " in textContent
		const escaped = this.textContent.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
		return escaped;
	}
}

class HTMLElement extends Node {
	constructor(tagName) {
		super();
		this.tagName = tagName.toUpperCase();
		this.attributes = new Map();
		this._innerHTML = ''; // fallback string content if no children
	}

	get nodeName() {
		return this.tagName;
	}
	get nodeType() {
		return ELEMENT_NODE;
	}

	set innerHTML(html) {
		this.setInnerHTML(html);
		this._innerHTML = html;
	}

	get innerHTML() {
		if (this.childNodes.length === 1 && this.childNodes[0] instanceof TextNode) {
			return this._innerHTML;
		}
		// fallback: serialize children
		return this.childNodes.map((n) => n.toString()).join('');
	}

	setAttribute(name, value) {
		this.attributes.set(name, String(value));
	}
	getAttribute(name) {
		return this.attributes.has(name) ? this.attributes.get(name) : null;
	}
	removeAttribute(name) {
		this.attributes.delete(name);
	}
	hasAttribute(name) {
		return this.attributes.has(name);
	}

	get outerHTML() {
		const attrs = [...this.attributes.entries()].map(([k, v]) => `${k}="${v.replace(/"/g, '&quot;')}"`).join(' ');
		const openTag = attrs ? `<${this.tagName} ${attrs}>` : `<${this.tagName}>`;

		const childrenHTML = this.childNodes.map((n) => n.toString()).join('');
		return `${openTag}${childrenHTML}</${this.tagName}>`;
	}

	toString() {
		return this.outerHTML;
	}
}

// Specialized for <head>
class HTMLHeadElement extends HTMLElement {
	constructor() {
		super('head');
	}
}

// Specialized for <body>
class HTMLBodyElement extends HTMLElement {
	constructor() {
		super('body');
	}
}

class HTMLDocument extends Node {
	constructor() {
		super();
		this.documentElement = new HTMLElement('html');
		this.appendChild(this.documentElement);

		this.head = new HTMLHeadElement();
		this.body = new HTMLBodyElement();

		this.documentElement.appendChild(this.head);
		this.documentElement.appendChild(this.body);
	}

	get nodeName() {
		return '#document';
	}
	get nodeType() {
		return 9; // DOCUMENT_NODE
	}

	get outerHTML() {
		return '<!DOCTYPE html>' + this.documentElement.outerHTML;
	}

	toString() {
		return this.outerHTML;
	}
}

// Helper: simple CSS selector parser & matcher (supports tag, #id, .class, [attr=value])
function matchesSelector(elem, selector) {
	if (!(elem instanceof HTMLElement)) return false;
	selector = selector.trim();

	// ID selector: #id
	if (selector.startsWith('#')) {
		const idToMatch = selector.slice(1);
		return elem.getAttribute('id') === idToMatch;
	}

	// Class selector: .class
	if (selector.startsWith('.')) {
		const classToMatch = selector.slice(1);
		const classAttr = elem.getAttribute('class') || '';
		const classes = classAttr.split(/\s+/);
		return classes.includes(classToMatch);
	}

	// Attribute selector: [attr=value]
	if (selector.startsWith('[') && selector.endsWith(']')) {
		const attrSelector = selector.slice(1, -1); // attr=value
		const [attr, val] = attrSelector.split('=');
		if (!attr) return false;
		if (val) {
			const attrVal = elem.getAttribute(attr);
			if (attrVal === null) return false;
			// Remove quotes around val if present
			const valUnquoted = val.replace(/^["']|["']$/g, '');
			return attrVal === valUnquoted;
		}
		return elem.hasAttribute(attr);
	}

	// Tag selector (case-insensitive)
	return elem.tagName.toLowerCase() === selector.toLowerCase();
}

// Recursive tree traversal helper (depth-first)
function traverse(node, callback) {
	if (!node) return;
	if (callback(node)) return node;
	for (const child of node.childNodes) {
		const found = traverse(child, callback);
		if (found) return found;
	}
	return null;
}

// Recursive tree traversal collecting matches
function collectAll(node, filterFn, collected = []) {
	if (!node) return collected;
	if (filterFn(node)) collected.push(node);
	for (const child of node.childNodes) {
		collectAll(child, filterFn, collected);
	}
	return collected;
}

// Add to HTMLElement & HTMLDocument prototypes:
HTMLElement.prototype.querySelector = function (selector) {
	return traverse(this, (node) => node instanceof HTMLElement && matchesSelector(node, selector));
};
HTMLElement.prototype.querySelectorAll = function (selector) {
	return new NodeList(collectAll(this, (node) => node instanceof HTMLElement && matchesSelector(node, selector)));
};
HTMLElement.prototype.getElementsByTagName = function (tagName) {
	const lowerTag = tagName.toLowerCase();
	return new NodeList(collectAll(this, (node) => node instanceof HTMLElement && node.tagName.toLowerCase() === lowerTag));
};
HTMLElement.prototype.getElementById = function (id) {
	return traverse(this, (node) => node instanceof HTMLElement && node.getAttribute('id') === id);
};

// For document, delegate to documentElement
HTMLDocument.prototype.querySelector = function (selector) {
	return this.documentElement.querySelector(selector);
};
HTMLDocument.prototype.querySelectorAll = function (selector) {
	return this.documentElement.querySelectorAll(selector);
};
HTMLDocument.prototype.getElementsByTagName = function (tagName) {
	return this.documentElement.getElementsByTagName(tagName);
};
HTMLDocument.prototype.getElementById = function (id) {
	return this.documentElement.getElementById(id);
};

// Add createElement method to document
HTMLDocument.prototype.createElement = function (tagName) {
	// For extension, create specialized classes if desired
	const tag = tagName.toLowerCase();

	return new HTMLElement(tag);
};
HTMLElement.prototype.setInnerHTML = function (html) {
	this.childNodes = []; // clear existing
	const tagRE = /<\/?([a-zA-Z0-9\-]+)([^>]*)\/?>|([^<]+)/g;
	const attrRE = /([a-zA-Z0-9\-:]+)(?:="([^"]*)")?/g;

	const stack = [this];
	let skipTextUntil = null;

	let match;
	while ((match = tagRE.exec(html))) {
		if (match[3]) {
			// Text node
			const text = match[3];
			if (skipTextUntil) {
				// Raw text mode (e.g., <script>...</script>)
				stack[stack.length - 1].appendChild(new TextNode(text));
				continue;
			}
			if (text.trim()) {
				stack[stack.length - 1].appendChild(new TextNode(text));
			}
		} else {
			const isClosing = match[0][1] === '/';
			const tagName = match[1].toLowerCase();
			const rawAttrs = match[2] || '';
			const isSelfClosing = match[0].endsWith('/>') || ['br', 'img', 'hr', 'input', 'meta', 'link'].includes(tagName);

			if (isClosing) {
				// End tag
				if (stack.length > 1 && stack[stack.length - 1].tagName.toLowerCase() === tagName) {
					stack.pop();
					if (skipTextUntil === tagName) skipTextUntil = null;
				}
			} else {
				// Opening tag
				const elem = new HTMLElement(tagName);
				let attr;
				while ((attr = attrRE.exec(rawAttrs))) {
					const [, name, value = ''] = attr;
					elem.setAttribute(name, value);
				}
				stack[stack.length - 1].appendChild(elem);

				if (!isSelfClosing) {
					stack.push(elem);
					if (tagName === 'script' || tagName === 'style') skipTextUntil = tagName;
				}
			}
		}
	}
};
HTMLElement.prototype.addClass = function (className) {
	const current = (this.getAttribute('class') || '').split(/\s+/).filter(Boolean);
	if (!current.includes(className)) {
		current.push(className);
		this.setAttribute('class', current.join(' '));
	}
};

HTMLElement.prototype.removeClass = function (className) {
	const current = (this.getAttribute('class') || '').split(/\s+/).filter(Boolean);
	const updated = current.filter((c) => c !== className);
	if (updated.length) {
		this.setAttribute('class', updated.join(' '));
	} else {
		this.removeAttribute('class');
	}
};

Object.defineProperty(HTMLElement.prototype, 'textContent', {
	get() {
		const collectText = (node) => {
			if (node instanceof TextNode) return node.textContent;
			if (node instanceof HTMLElement) {
				return node.childNodes.map(collectText).join('');
			}
			return '';
		};
		return collectText(this);
	},
	set(value) {
		this.childNodes = [];
		this.appendChild(new TextNode(value));
	},
});

// jQuery-style alias
HTMLElement.prototype.text = function (value) {
	if (value === undefined) return this.textContent;
	this.textContent = value;
	return this;
};
Object.defineProperty(HTMLElement.prototype, 'style', {
	get() {
		if (!this._style) {
			this._style = new Proxy(
				{},
				{
					get: (_, prop) => {
						const style = this.getAttribute('style') || '';
						const map = Object.fromEntries(
							style
								.split(';')
								.map((s) =>
									s
										.trim()
										.split(':')
										.map((x) => x.trim())
								)
								.filter(([k, v]) => k && v)
						);
						return map[prop] || '';
					},
					set: (_, prop, value) => {
						const style = this.getAttribute('style') || '';
						const map = Object.fromEntries(
							style
								.split(';')
								.map((s) =>
									s
										.trim()
										.split(':')
										.map((x) => x.trim())
								)
								.filter(([k, v]) => k && v)
						);
						map[prop] = value;
						const serialized = Object.entries(map)
							.map(([k, v]) => `${k}: ${v}`)
							.join('; ');
						this.setAttribute('style', serialized);
						return true;
					},
					deleteProperty: (_, prop) => {
						const style = this.getAttribute('style') || '';
						const map = Object.fromEntries(
							style
								.split(';')
								.map((s) =>
									s
										.trim()
										.split(':')
										.map((x) => x.trim())
								)
								.filter(([k, v]) => k && v)
						);
						delete map[prop];
						const serialized = Object.entries(map)
							.map(([k, v]) => `${k}: ${v}`)
							.join('; ');
						this.setAttribute('style', serialized);
						return true;
					},
				}
			);
		}
		return this._style;
	},
});
class DOMParser {
	parseFromString(input, type) {
		if (type === 'text/html') {
			const doc = new HTMLDocument();
			doc.body.innerHTML = input;
			return doc;
		} else if (type === 'application/json') {
			const doc = new HTMLDocument();
			const root = this._buildFromJSON(input);
			if (root) {
				doc.body.appendChild(root);
			}
			return doc;
		} else {
			throw new Error(`Unsupported content type: ${type}`);
		}
	}

	_buildFromJSON(json) {
		if (typeof json === 'string') {
			return new TextNode(json);
		}

		if (!json || typeof json !== 'object' || !json.tag) {
			return null;
		}

		const elem = new HTMLElement(json.tag);

		// Set attributes
		if (json.attrs && typeof json.attrs === 'object') {
			for (const [name, value] of Object.entries(json.attrs)) {
				elem.setAttribute(name, value);
			}
		}

		// Recurse on children
		if (Array.isArray(json.children)) {
			for (const child of json.children) {
				const node = this._buildFromJSON(child);
				if (node) {
					elem.appendChild(node);
				}
			}
		}

		return elem;
	}
}
const originalSetAttribute = HTMLElement.prototype.setAttribute;
HTMLElement.prototype.setAttribute = function (name, value) {
	if (name === 'style') delete this._style;
	return originalSetAttribute.call(this, name, value);
};
const originalRemoveAttribute = HTMLElement.prototype.removeAttribute;
HTMLElement.prototype.removeAttribute = function (name) {
	if (name === 'style') delete this._style;
	return originalRemoveAttribute.call(this, name);
};
HTMLElement.prototype.formatHTML = function (data = {}) {
	if (!this._innerHTML) return this;

	// Replace {{key}} in _innerHTML with data[key] if exists, else leave as is
	let formatted = this._innerHTML.replace(/\{\{(\w+)\}\}/g, (match, key) => {
		return key in data ? data[key] : match;
	});

	this.innerHTML = formatted;
	return this;
};

class HTMLWidget {
	// Parse from HTML string and return the permanent container <div class="html-widget"> holding parsed nodes
	static fromString(htmlString) {
		// Create the permanent container
		const container = new HTMLElement('div');
		container.addClass('html-widget');

		// Parse fragment inside container
		container.innerHTML = htmlString.trim();

		// Return the container with parsed content inside
		return container;
	}

	// Parse from JSON and return the permanent container <div class="html-widget"> holding parsed nodes
	static fromJSON(json) {
		function build(nodeJson) {
			if (typeof nodeJson === 'string') return new TextNode(nodeJson);

			if (!nodeJson || typeof nodeJson !== 'object' || !nodeJson.tag) return null;

			const elem = new HTMLElement(nodeJson.tag);

			if (nodeJson.attrs && typeof nodeJson.attrs === 'object') {
				for (const [k, v] of Object.entries(nodeJson.attrs)) {
					elem.setAttribute(k, v);
				}
			}

			if (Array.isArray(nodeJson.children)) {
				for (const child of nodeJson.children) {
					const childNode = build(child);
					if (childNode) elem.appendChild(childNode);
				}
			}

			return elem;
		}

		const container = new HTMLElement('div');
		container.addClass('html-widget');

		if (Array.isArray(json)) {
			json.forEach((nodeJson) => {
				const node = build(nodeJson);
				if (node) container.appendChild(node);
			});
		} else {
			const node = build(json);
			if (node) container.appendChild(node);
		}

		return container;
	}
}

module.exports = {
	ELEMENT_NODE,
	TEXT_NODE,
	Node,
	TextNode,
	HTMLElement,
	HTMLHeadElement,
	HTMLBodyElement,
	HTMLDocument,
	NodeList,
	DOMParser,
	HTMLWidget,
};

//cloudflare-workers-compatible-virtual-dom.js
