// @bun
var __create = Object.create;
var __getProtoOf = Object.getPrototypeOf;
var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
function __accessProp(key) {
  return this[key];
}
var __toESMCache_node;
var __toESMCache_esm;
var __toESM = (mod, isNodeMode, target) => {
  var canCache = mod != null && typeof mod === "object";
  if (canCache) {
    var cache = isNodeMode ? __toESMCache_node ??= new WeakMap : __toESMCache_esm ??= new WeakMap;
    var cached = cache.get(mod);
    if (cached)
      return cached;
  }
  target = mod != null ? __create(__getProtoOf(mod)) : {};
  const to = isNodeMode || !mod || !mod.__esModule || !__hasOwnProp.call(mod, "default") ? __defProp(target, "default", { value: mod, enumerable: true }) : target;
  if (mod && typeof mod === "object" || typeof mod === "function") {
    for (let key of __getOwnPropNames(mod))
      if (!__hasOwnProp.call(to, key))
        __defProp(to, key, {
          get: __accessProp.bind(mod, key),
          enumerable: true
        });
  }
  if (canCache)
    cache.set(mod, to);
  return to;
};
var __commonJS = (cb, mod) => () => (mod || cb((mod = { exports: {} }).exports, mod), mod.exports);
var __require = import.meta.require;

// node_modules/@xterm/headless/lib-headless/xterm-headless.js
var require_xterm_headless = __commonJS(function(exports) {
  (() => {
    var e = { 5639: (e, t, s) => {
      Object.defineProperty(t, "__esModule", { value: true }), t.CircularList = undefined;
      const i = s(7150), r = s(802);

      class n extends i.Disposable {
        constructor(e) {
          super(), this._maxLength = e, this.onDeleteEmitter = this._register(new r.Emitter), this.onDelete = this.onDeleteEmitter.event, this.onInsertEmitter = this._register(new r.Emitter), this.onInsert = this.onInsertEmitter.event, this.onTrimEmitter = this._register(new r.Emitter), this.onTrim = this.onTrimEmitter.event, this._array = new Array(this._maxLength), this._startIndex = 0, this._length = 0;
        }
        get maxLength() {
          return this._maxLength;
        }
        set maxLength(e) {
          if (this._maxLength === e)
            return;
          const t = new Array(e);
          for (let s = 0;s < Math.min(e, this.length); s++)
            t[s] = this._array[this._getCyclicIndex(s)];
          this._array = t, this._maxLength = e, this._startIndex = 0;
        }
        get length() {
          return this._length;
        }
        set length(e) {
          if (e > this._length)
            for (let t = this._length;t < e; t++)
              this._array[t] = undefined;
          this._length = e;
        }
        get(e) {
          return this._array[this._getCyclicIndex(e)];
        }
        set(e, t) {
          this._array[this._getCyclicIndex(e)] = t;
        }
        push(e) {
          this._array[this._getCyclicIndex(this._length)] = e, this._length === this._maxLength ? (this._startIndex = ++this._startIndex % this._maxLength, this.onTrimEmitter.fire(1)) : this._length++;
        }
        recycle() {
          if (this._length !== this._maxLength)
            throw new Error("Can only recycle when the buffer is full");
          return this._startIndex = ++this._startIndex % this._maxLength, this.onTrimEmitter.fire(1), this._array[this._getCyclicIndex(this._length - 1)];
        }
        get isFull() {
          return this._length === this._maxLength;
        }
        pop() {
          return this._array[this._getCyclicIndex(this._length-- - 1)];
        }
        splice(e, t, ...s) {
          if (t) {
            for (let s = e;s < this._length - t; s++)
              this._array[this._getCyclicIndex(s)] = this._array[this._getCyclicIndex(s + t)];
            this._length -= t, this.onDeleteEmitter.fire({ index: e, amount: t });
          }
          for (let t = this._length - 1;t >= e; t--)
            this._array[this._getCyclicIndex(t + s.length)] = this._array[this._getCyclicIndex(t)];
          for (let t = 0;t < s.length; t++)
            this._array[this._getCyclicIndex(e + t)] = s[t];
          if (s.length && this.onInsertEmitter.fire({ index: e, amount: s.length }), this._length + s.length > this._maxLength) {
            const e = this._length + s.length - this._maxLength;
            this._startIndex += e, this._length = this._maxLength, this.onTrimEmitter.fire(e);
          } else
            this._length += s.length;
        }
        trimStart(e) {
          e > this._length && (e = this._length), this._startIndex += e, this._length -= e, this.onTrimEmitter.fire(e);
        }
        shiftElements(e, t, s) {
          if (!(t <= 0)) {
            if (e < 0 || e >= this._length)
              throw new Error("start argument out of range");
            if (e + s < 0)
              throw new Error("Cannot shift elements in list beyond index 0");
            if (s > 0) {
              for (let i = t - 1;i >= 0; i--)
                this.set(e + i + s, this.get(e + i));
              const i = e + t + s - this._length;
              if (i > 0)
                for (this._length += i;this._length > this._maxLength; )
                  this._length--, this._startIndex++, this.onTrimEmitter.fire(1);
            } else
              for (let i = 0;i < t; i++)
                this.set(e + i + s, this.get(e + i));
          }
        }
        _getCyclicIndex(e) {
          return (this._startIndex + e) % this._maxLength;
        }
      }
      t.CircularList = n;
    }, 7453: (e, t) => {
      Object.defineProperty(t, "__esModule", { value: true }), t.clone = function e(t, s = 5) {
        if (typeof t != "object")
          return t;
        const i = Array.isArray(t) ? [] : {};
        for (const r in t)
          i[r] = s <= 1 ? t[r] : t[r] && e(t[r], s - 1);
        return i;
      };
    }, 5777: (e, t, s) => {
      Object.defineProperty(t, "__esModule", { value: true }), t.CoreTerminal = undefined;
      const i = s(6501), r = s(6025), n = s(7276), o = s(9640), a = s(56), h = s(4071), c = s(7792), l = s(6415), u = s(5746), d = s(5882), f = s(2486), _ = s(3562), p = s(8811), g = s(802), v = s(7150);
      let m = false;

      class b extends v.Disposable {
        get onScroll() {
          return this._onScrollApi || (this._onScrollApi = this._register(new g.Emitter), this._onScroll.event((e) => {
            this._onScrollApi?.fire(e.position);
          })), this._onScrollApi.event;
        }
        get cols() {
          return this._bufferService.cols;
        }
        get rows() {
          return this._bufferService.rows;
        }
        get buffers() {
          return this._bufferService.buffers;
        }
        get options() {
          return this.optionsService.options;
        }
        set options(e) {
          for (const t in e)
            this.optionsService.options[t] = e[t];
        }
        constructor(e) {
          super(), this._windowsWrappingHeuristics = this._register(new v.MutableDisposable), this._onBinary = this._register(new g.Emitter), this.onBinary = this._onBinary.event, this._onData = this._register(new g.Emitter), this.onData = this._onData.event, this._onLineFeed = this._register(new g.Emitter), this.onLineFeed = this._onLineFeed.event, this._onResize = this._register(new g.Emitter), this.onResize = this._onResize.event, this._onWriteParsed = this._register(new g.Emitter), this.onWriteParsed = this._onWriteParsed.event, this._onScroll = this._register(new g.Emitter), this._instantiationService = new r.InstantiationService, this.optionsService = this._register(new a.OptionsService(e)), this._instantiationService.setService(i.IOptionsService, this.optionsService), this._bufferService = this._register(this._instantiationService.createInstance(o.BufferService)), this._instantiationService.setService(i.IBufferService, this._bufferService), this._logService = this._register(this._instantiationService.createInstance(n.LogService)), this._instantiationService.setService(i.ILogService, this._logService), this.coreService = this._register(this._instantiationService.createInstance(h.CoreService)), this._instantiationService.setService(i.ICoreService, this.coreService), this.coreMouseService = this._register(this._instantiationService.createInstance(c.CoreMouseService)), this._instantiationService.setService(i.ICoreMouseService, this.coreMouseService), this.unicodeService = this._register(this._instantiationService.createInstance(l.UnicodeService)), this._instantiationService.setService(i.IUnicodeService, this.unicodeService), this._charsetService = this._instantiationService.createInstance(u.CharsetService), this._instantiationService.setService(i.ICharsetService, this._charsetService), this._oscLinkService = this._instantiationService.createInstance(p.OscLinkService), this._instantiationService.setService(i.IOscLinkService, this._oscLinkService), this._inputHandler = this._register(new f.InputHandler(this._bufferService, this._charsetService, this.coreService, this._logService, this.optionsService, this._oscLinkService, this.coreMouseService, this.unicodeService)), this._register(g.Event.forward(this._inputHandler.onLineFeed, this._onLineFeed)), this._register(this._inputHandler), this._register(g.Event.forward(this._bufferService.onResize, this._onResize)), this._register(g.Event.forward(this.coreService.onData, this._onData)), this._register(g.Event.forward(this.coreService.onBinary, this._onBinary)), this._register(this.coreService.onRequestScrollToBottom(() => this.scrollToBottom(true))), this._register(this.coreService.onUserInput(() => this._writeBuffer.handleUserInput())), this._register(this.optionsService.onMultipleOptionChange(["windowsMode", "windowsPty"], () => this._handleWindowsPtyOptionChange())), this._register(this._bufferService.onScroll(() => {
            this._onScroll.fire({ position: this._bufferService.buffer.ydisp }), this._inputHandler.markRangeDirty(this._bufferService.buffer.scrollTop, this._bufferService.buffer.scrollBottom);
          })), this._writeBuffer = this._register(new _.WriteBuffer((e, t) => this._inputHandler.parse(e, t))), this._register(g.Event.forward(this._writeBuffer.onWriteParsed, this._onWriteParsed));
        }
        write(e, t) {
          this._writeBuffer.write(e, t);
        }
        writeSync(e, t) {
          this._logService.logLevel <= i.LogLevelEnum.WARN && !m && (this._logService.warn("writeSync is unreliable and will be removed soon."), m = true), this._writeBuffer.writeSync(e, t);
        }
        input(e, t = true) {
          this.coreService.triggerDataEvent(e, t);
        }
        resize(e, t) {
          isNaN(e) || isNaN(t) || (e = Math.max(e, o.MINIMUM_COLS), t = Math.max(t, o.MINIMUM_ROWS), this._bufferService.resize(e, t));
        }
        scroll(e, t = false) {
          this._bufferService.scroll(e, t);
        }
        scrollLines(e, t) {
          this._bufferService.scrollLines(e, t);
        }
        scrollPages(e) {
          this.scrollLines(e * (this.rows - 1));
        }
        scrollToTop() {
          this.scrollLines(-this._bufferService.buffer.ydisp);
        }
        scrollToBottom(e) {
          this.scrollLines(this._bufferService.buffer.ybase - this._bufferService.buffer.ydisp);
        }
        scrollToLine(e) {
          const t = e - this._bufferService.buffer.ydisp;
          t !== 0 && this.scrollLines(t);
        }
        registerEscHandler(e, t) {
          return this._inputHandler.registerEscHandler(e, t);
        }
        registerDcsHandler(e, t) {
          return this._inputHandler.registerDcsHandler(e, t);
        }
        registerCsiHandler(e, t) {
          return this._inputHandler.registerCsiHandler(e, t);
        }
        registerOscHandler(e, t) {
          return this._inputHandler.registerOscHandler(e, t);
        }
        _setup() {
          this._handleWindowsPtyOptionChange();
        }
        reset() {
          this._inputHandler.reset(), this._bufferService.reset(), this._charsetService.reset(), this.coreService.reset(), this.coreMouseService.reset();
        }
        _handleWindowsPtyOptionChange() {
          let e = false;
          const t = this.optionsService.rawOptions.windowsPty;
          t && t.buildNumber !== undefined && t.buildNumber !== undefined ? e = !!(t.backend === "conpty" && t.buildNumber < 21376) : this.optionsService.rawOptions.windowsMode && (e = true), e ? this._enableWindowsWrappingHeuristics() : this._windowsWrappingHeuristics.clear();
        }
        _enableWindowsWrappingHeuristics() {
          if (!this._windowsWrappingHeuristics.value) {
            const e = [];
            e.push(this.onLineFeed(d.updateWindowsModeWrappedState.bind(null, this._bufferService))), e.push(this.registerCsiHandler({ final: "H" }, () => ((0, d.updateWindowsModeWrappedState)(this._bufferService), false))), this._windowsWrappingHeuristics.value = (0, v.toDisposable)(() => {
              for (const t of e)
                t.dispose();
            });
          }
        }
      }
      t.CoreTerminal = b;
    }, 2486: function(e, t, s) {
      var i = this && this.__decorate || function(e, t, s, i) {
        var r, n = arguments.length, o = n < 3 ? t : i === null ? i = Object.getOwnPropertyDescriptor(t, s) : i;
        if (typeof Reflect == "object" && typeof Reflect.decorate == "function")
          o = Reflect.decorate(e, t, s, i);
        else
          for (var a = e.length - 1;a >= 0; a--)
            (r = e[a]) && (o = (n < 3 ? r(o) : n > 3 ? r(t, s, o) : r(t, s)) || o);
        return n > 3 && o && Object.defineProperty(t, s, o), o;
      }, r = this && this.__param || function(e, t) {
        return function(s, i) {
          t(s, i, e);
        };
      };
      Object.defineProperty(t, "__esModule", { value: true }), t.InputHandler = t.WindowsOptionsReportType = undefined, t.isValidColorIndex = k;
      const n = s(3534), o = s(6760), a = s(6717), h = s(7150), c = s(726), l = s(6107), u = s(8938), d = s(3055), f = s(5451), _ = s(6501), p = s(6415), g = s(1346), v = s(9823), m = s(8693), b = s(802), S = { "(": 0, ")": 1, "*": 2, "+": 3, "-": 1, ".": 2 }, y = 131072;
      function C(e, t) {
        if (e > 24)
          return t.setWinLines || false;
        switch (e) {
          case 1:
            return !!t.restoreWin;
          case 2:
            return !!t.minimizeWin;
          case 3:
            return !!t.setWinPosition;
          case 4:
            return !!t.setWinSizePixels;
          case 5:
            return !!t.raiseWin;
          case 6:
            return !!t.lowerWin;
          case 7:
            return !!t.refreshWin;
          case 8:
            return !!t.setWinSizeChars;
          case 9:
            return !!t.maximizeWin;
          case 10:
            return !!t.fullscreenWin;
          case 11:
            return !!t.getWinState;
          case 13:
            return !!t.getWinPosition;
          case 14:
            return !!t.getWinSizePixels;
          case 15:
            return !!t.getScreenSizePixels;
          case 16:
            return !!t.getCellSizePixels;
          case 18:
            return !!t.getWinSizeChars;
          case 19:
            return !!t.getScreenSizeChars;
          case 20:
            return !!t.getIconTitle;
          case 21:
            return !!t.getWinTitle;
          case 22:
            return !!t.pushTitle;
          case 23:
            return !!t.popTitle;
          case 24:
            return !!t.setWinLines;
        }
        return false;
      }
      var w;
      (function(e) {
        e[e.GET_WIN_SIZE_PIXELS = 0] = "GET_WIN_SIZE_PIXELS", e[e.GET_CELL_SIZE_PIXELS = 1] = "GET_CELL_SIZE_PIXELS";
      })(w || (t.WindowsOptionsReportType = w = {}));
      let E = 0;

      class A extends h.Disposable {
        getAttrData() {
          return this._curAttrData;
        }
        constructor(e, t, s, i, r, h, u, d, f = new a.EscapeSequenceParser) {
          super(), this._bufferService = e, this._charsetService = t, this._coreService = s, this._logService = i, this._optionsService = r, this._oscLinkService = h, this._coreMouseService = u, this._unicodeService = d, this._parser = f, this._parseBuffer = new Uint32Array(4096), this._stringDecoder = new c.StringToUtf32, this._utf8Decoder = new c.Utf8ToUtf32, this._windowTitle = "", this._iconName = "", this._windowTitleStack = [], this._iconNameStack = [], this._curAttrData = l.DEFAULT_ATTR_DATA.clone(), this._eraseAttrDataInternal = l.DEFAULT_ATTR_DATA.clone(), this._onRequestBell = this._register(new b.Emitter), this.onRequestBell = this._onRequestBell.event, this._onRequestRefreshRows = this._register(new b.Emitter), this.onRequestRefreshRows = this._onRequestRefreshRows.event, this._onRequestReset = this._register(new b.Emitter), this.onRequestReset = this._onRequestReset.event, this._onRequestSendFocus = this._register(new b.Emitter), this.onRequestSendFocus = this._onRequestSendFocus.event, this._onRequestSyncScrollBar = this._register(new b.Emitter), this.onRequestSyncScrollBar = this._onRequestSyncScrollBar.event, this._onRequestWindowsOptionsReport = this._register(new b.Emitter), this.onRequestWindowsOptionsReport = this._onRequestWindowsOptionsReport.event, this._onA11yChar = this._register(new b.Emitter), this.onA11yChar = this._onA11yChar.event, this._onA11yTab = this._register(new b.Emitter), this.onA11yTab = this._onA11yTab.event, this._onCursorMove = this._register(new b.Emitter), this.onCursorMove = this._onCursorMove.event, this._onLineFeed = this._register(new b.Emitter), this.onLineFeed = this._onLineFeed.event, this._onScroll = this._register(new b.Emitter), this.onScroll = this._onScroll.event, this._onTitleChange = this._register(new b.Emitter), this.onTitleChange = this._onTitleChange.event, this._onColor = this._register(new b.Emitter), this.onColor = this._onColor.event, this._parseStack = { paused: false, cursorStartX: 0, cursorStartY: 0, decodedLength: 0, position: 0 }, this._specialColors = [256, 257, 258], this._register(this._parser), this._dirtyRowTracker = new L(this._bufferService), this._activeBuffer = this._bufferService.buffer, this._register(this._bufferService.buffers.onBufferActivate((e) => this._activeBuffer = e.activeBuffer)), this._parser.setCsiHandlerFallback((e, t) => {
            this._logService.debug("Unknown CSI code: ", { identifier: this._parser.identToString(e), params: t.toArray() });
          }), this._parser.setEscHandlerFallback((e) => {
            this._logService.debug("Unknown ESC code: ", { identifier: this._parser.identToString(e) });
          }), this._parser.setExecuteHandlerFallback((e) => {
            this._logService.debug("Unknown EXECUTE code: ", { code: e });
          }), this._parser.setOscHandlerFallback((e, t, s) => {
            this._logService.debug("Unknown OSC code: ", { identifier: e, action: t, data: s });
          }), this._parser.setDcsHandlerFallback((e, t, s) => {
            t === "HOOK" && (s = s.toArray()), this._logService.debug("Unknown DCS code: ", { identifier: this._parser.identToString(e), action: t, payload: s });
          }), this._parser.setPrintHandler((e, t, s) => this.print(e, t, s)), this._parser.registerCsiHandler({ final: "@" }, (e) => this.insertChars(e)), this._parser.registerCsiHandler({ intermediates: " ", final: "@" }, (e) => this.scrollLeft(e)), this._parser.registerCsiHandler({ final: "A" }, (e) => this.cursorUp(e)), this._parser.registerCsiHandler({ intermediates: " ", final: "A" }, (e) => this.scrollRight(e)), this._parser.registerCsiHandler({ final: "B" }, (e) => this.cursorDown(e)), this._parser.registerCsiHandler({ final: "C" }, (e) => this.cursorForward(e)), this._parser.registerCsiHandler({ final: "D" }, (e) => this.cursorBackward(e)), this._parser.registerCsiHandler({ final: "E" }, (e) => this.cursorNextLine(e)), this._parser.registerCsiHandler({ final: "F" }, (e) => this.cursorPrecedingLine(e)), this._parser.registerCsiHandler({ final: "G" }, (e) => this.cursorCharAbsolute(e)), this._parser.registerCsiHandler({ final: "H" }, (e) => this.cursorPosition(e)), this._parser.registerCsiHandler({ final: "I" }, (e) => this.cursorForwardTab(e)), this._parser.registerCsiHandler({ final: "J" }, (e) => this.eraseInDisplay(e, false)), this._parser.registerCsiHandler({ prefix: "?", final: "J" }, (e) => this.eraseInDisplay(e, true)), this._parser.registerCsiHandler({ final: "K" }, (e) => this.eraseInLine(e, false)), this._parser.registerCsiHandler({ prefix: "?", final: "K" }, (e) => this.eraseInLine(e, true)), this._parser.registerCsiHandler({ final: "L" }, (e) => this.insertLines(e)), this._parser.registerCsiHandler({ final: "M" }, (e) => this.deleteLines(e)), this._parser.registerCsiHandler({ final: "P" }, (e) => this.deleteChars(e)), this._parser.registerCsiHandler({ final: "S" }, (e) => this.scrollUp(e)), this._parser.registerCsiHandler({ final: "T" }, (e) => this.scrollDown(e)), this._parser.registerCsiHandler({ final: "X" }, (e) => this.eraseChars(e)), this._parser.registerCsiHandler({ final: "Z" }, (e) => this.cursorBackwardTab(e)), this._parser.registerCsiHandler({ final: "`" }, (e) => this.charPosAbsolute(e)), this._parser.registerCsiHandler({ final: "a" }, (e) => this.hPositionRelative(e)), this._parser.registerCsiHandler({ final: "b" }, (e) => this.repeatPrecedingCharacter(e)), this._parser.registerCsiHandler({ final: "c" }, (e) => this.sendDeviceAttributesPrimary(e)), this._parser.registerCsiHandler({ prefix: ">", final: "c" }, (e) => this.sendDeviceAttributesSecondary(e)), this._parser.registerCsiHandler({ final: "d" }, (e) => this.linePosAbsolute(e)), this._parser.registerCsiHandler({ final: "e" }, (e) => this.vPositionRelative(e)), this._parser.registerCsiHandler({ final: "f" }, (e) => this.hVPosition(e)), this._parser.registerCsiHandler({ final: "g" }, (e) => this.tabClear(e)), this._parser.registerCsiHandler({ final: "h" }, (e) => this.setMode(e)), this._parser.registerCsiHandler({ prefix: "?", final: "h" }, (e) => this.setModePrivate(e)), this._parser.registerCsiHandler({ final: "l" }, (e) => this.resetMode(e)), this._parser.registerCsiHandler({ prefix: "?", final: "l" }, (e) => this.resetModePrivate(e)), this._parser.registerCsiHandler({ final: "m" }, (e) => this.charAttributes(e)), this._parser.registerCsiHandler({ final: "n" }, (e) => this.deviceStatus(e)), this._parser.registerCsiHandler({ prefix: "?", final: "n" }, (e) => this.deviceStatusPrivate(e)), this._parser.registerCsiHandler({ intermediates: "!", final: "p" }, (e) => this.softReset(e)), this._parser.registerCsiHandler({ intermediates: " ", final: "q" }, (e) => this.setCursorStyle(e)), this._parser.registerCsiHandler({ final: "r" }, (e) => this.setScrollRegion(e)), this._parser.registerCsiHandler({ final: "s" }, (e) => this.saveCursor(e)), this._parser.registerCsiHandler({ final: "t" }, (e) => this.windowOptions(e)), this._parser.registerCsiHandler({ final: "u" }, (e) => this.restoreCursor(e)), this._parser.registerCsiHandler({ intermediates: "'", final: "}" }, (e) => this.insertColumns(e)), this._parser.registerCsiHandler({ intermediates: "'", final: "~" }, (e) => this.deleteColumns(e)), this._parser.registerCsiHandler({ intermediates: '"', final: "q" }, (e) => this.selectProtected(e)), this._parser.registerCsiHandler({ intermediates: "$", final: "p" }, (e) => this.requestMode(e, true)), this._parser.registerCsiHandler({ prefix: "?", intermediates: "$", final: "p" }, (e) => this.requestMode(e, false)), this._parser.setExecuteHandler(n.C0.BEL, () => this.bell()), this._parser.setExecuteHandler(n.C0.LF, () => this.lineFeed()), this._parser.setExecuteHandler(n.C0.VT, () => this.lineFeed()), this._parser.setExecuteHandler(n.C0.FF, () => this.lineFeed()), this._parser.setExecuteHandler(n.C0.CR, () => this.carriageReturn()), this._parser.setExecuteHandler(n.C0.BS, () => this.backspace()), this._parser.setExecuteHandler(n.C0.HT, () => this.tab()), this._parser.setExecuteHandler(n.C0.SO, () => this.shiftOut()), this._parser.setExecuteHandler(n.C0.SI, () => this.shiftIn()), this._parser.setExecuteHandler(n.C1.IND, () => this.index()), this._parser.setExecuteHandler(n.C1.NEL, () => this.nextLine()), this._parser.setExecuteHandler(n.C1.HTS, () => this.tabSet()), this._parser.registerOscHandler(0, new g.OscHandler((e) => (this.setTitle(e), this.setIconName(e), true))), this._parser.registerOscHandler(1, new g.OscHandler((e) => this.setIconName(e))), this._parser.registerOscHandler(2, new g.OscHandler((e) => this.setTitle(e))), this._parser.registerOscHandler(4, new g.OscHandler((e) => this.setOrReportIndexedColor(e))), this._parser.registerOscHandler(8, new g.OscHandler((e) => this.setHyperlink(e))), this._parser.registerOscHandler(10, new g.OscHandler((e) => this.setOrReportFgColor(e))), this._parser.registerOscHandler(11, new g.OscHandler((e) => this.setOrReportBgColor(e))), this._parser.registerOscHandler(12, new g.OscHandler((e) => this.setOrReportCursorColor(e))), this._parser.registerOscHandler(104, new g.OscHandler((e) => this.restoreIndexedColor(e))), this._parser.registerOscHandler(110, new g.OscHandler((e) => this.restoreFgColor(e))), this._parser.registerOscHandler(111, new g.OscHandler((e) => this.restoreBgColor(e))), this._parser.registerOscHandler(112, new g.OscHandler((e) => this.restoreCursorColor(e))), this._parser.registerEscHandler({ final: "7" }, () => this.saveCursor()), this._parser.registerEscHandler({ final: "8" }, () => this.restoreCursor()), this._parser.registerEscHandler({ final: "D" }, () => this.index()), this._parser.registerEscHandler({ final: "E" }, () => this.nextLine()), this._parser.registerEscHandler({ final: "H" }, () => this.tabSet()), this._parser.registerEscHandler({ final: "M" }, () => this.reverseIndex()), this._parser.registerEscHandler({ final: "=" }, () => this.keypadApplicationMode()), this._parser.registerEscHandler({ final: ">" }, () => this.keypadNumericMode()), this._parser.registerEscHandler({ final: "c" }, () => this.fullReset()), this._parser.registerEscHandler({ final: "n" }, () => this.setgLevel(2)), this._parser.registerEscHandler({ final: "o" }, () => this.setgLevel(3)), this._parser.registerEscHandler({ final: "|" }, () => this.setgLevel(3)), this._parser.registerEscHandler({ final: "}" }, () => this.setgLevel(2)), this._parser.registerEscHandler({ final: "~" }, () => this.setgLevel(1)), this._parser.registerEscHandler({ intermediates: "%", final: "@" }, () => this.selectDefaultCharset()), this._parser.registerEscHandler({ intermediates: "%", final: "G" }, () => this.selectDefaultCharset());
          for (const e in o.CHARSETS)
            this._parser.registerEscHandler({ intermediates: "(", final: e }, () => this.selectCharset("(" + e)), this._parser.registerEscHandler({ intermediates: ")", final: e }, () => this.selectCharset(")" + e)), this._parser.registerEscHandler({ intermediates: "*", final: e }, () => this.selectCharset("*" + e)), this._parser.registerEscHandler({ intermediates: "+", final: e }, () => this.selectCharset("+" + e)), this._parser.registerEscHandler({ intermediates: "-", final: e }, () => this.selectCharset("-" + e)), this._parser.registerEscHandler({ intermediates: ".", final: e }, () => this.selectCharset("." + e)), this._parser.registerEscHandler({ intermediates: "/", final: e }, () => this.selectCharset("/" + e));
          this._parser.registerEscHandler({ intermediates: "#", final: "8" }, () => this.screenAlignmentPattern()), this._parser.setErrorHandler((e) => (this._logService.error("Parsing error: ", e), e)), this._parser.registerDcsHandler({ intermediates: "$", final: "q" }, new v.DcsHandler((e, t) => this.requestStatusString(e, t)));
        }
        _preserveStack(e, t, s, i) {
          this._parseStack.paused = true, this._parseStack.cursorStartX = e, this._parseStack.cursorStartY = t, this._parseStack.decodedLength = s, this._parseStack.position = i;
        }
        _logSlowResolvingAsync(e) {
          this._logService.logLevel <= _.LogLevelEnum.WARN && Promise.race([e, new Promise((e, t) => setTimeout(() => t("#SLOW_TIMEOUT"), 5000))]).catch((e) => {
            if (e !== "#SLOW_TIMEOUT")
              throw e;
            console.warn("async parser handler taking longer than 5000 ms");
          });
        }
        _getCurrentLinkId() {
          return this._curAttrData.extended.urlId;
        }
        parse(e, t) {
          let s, i = this._activeBuffer.x, r = this._activeBuffer.y, n = 0;
          const o = this._parseStack.paused;
          if (o) {
            if (s = this._parser.parse(this._parseBuffer, this._parseStack.decodedLength, t))
              return this._logSlowResolvingAsync(s), s;
            i = this._parseStack.cursorStartX, r = this._parseStack.cursorStartY, this._parseStack.paused = false, e.length > y && (n = this._parseStack.position + y);
          }
          if (this._logService.logLevel <= _.LogLevelEnum.DEBUG && this._logService.debug("parsing data " + (typeof e == "string" ? ` "${e}"` : ` "${Array.prototype.map.call(e, (e) => String.fromCharCode(e)).join("")}"`)), this._logService.logLevel === _.LogLevelEnum.TRACE && this._logService.trace("parsing data (codes)", typeof e == "string" ? e.split("").map((e) => e.charCodeAt(0)) : e), this._parseBuffer.length < e.length && this._parseBuffer.length < y && (this._parseBuffer = new Uint32Array(Math.min(e.length, y))), o || this._dirtyRowTracker.clearRange(), e.length > y)
            for (let t = n;t < e.length; t += y) {
              const n = t + y < e.length ? t + y : e.length, o = typeof e == "string" ? this._stringDecoder.decode(e.substring(t, n), this._parseBuffer) : this._utf8Decoder.decode(e.subarray(t, n), this._parseBuffer);
              if (s = this._parser.parse(this._parseBuffer, o))
                return this._preserveStack(i, r, o, t), this._logSlowResolvingAsync(s), s;
            }
          else if (!o) {
            const t = typeof e == "string" ? this._stringDecoder.decode(e, this._parseBuffer) : this._utf8Decoder.decode(e, this._parseBuffer);
            if (s = this._parser.parse(this._parseBuffer, t))
              return this._preserveStack(i, r, t, 0), this._logSlowResolvingAsync(s), s;
          }
          this._activeBuffer.x === i && this._activeBuffer.y === r || this._onCursorMove.fire();
          const a = this._dirtyRowTracker.end + (this._bufferService.buffer.ybase - this._bufferService.buffer.ydisp), h = this._dirtyRowTracker.start + (this._bufferService.buffer.ybase - this._bufferService.buffer.ydisp);
          h < this._bufferService.rows && this._onRequestRefreshRows.fire({ start: Math.min(h, this._bufferService.rows - 1), end: Math.min(a, this._bufferService.rows - 1) });
        }
        print(e, t, s) {
          let i, r;
          const n = this._charsetService.charset, o = this._optionsService.rawOptions.screenReaderMode, a = this._bufferService.cols, h = this._coreService.decPrivateModes.wraparound, d = this._coreService.modes.insertMode, f = this._curAttrData;
          let _ = this._activeBuffer.lines.get(this._activeBuffer.ybase + this._activeBuffer.y);
          this._dirtyRowTracker.markDirty(this._activeBuffer.y), this._activeBuffer.x && s - t > 0 && _.getWidth(this._activeBuffer.x - 1) === 2 && _.setCellFromCodepoint(this._activeBuffer.x - 1, 0, 1, f);
          let g = this._parser.precedingJoinState;
          for (let v = t;v < s; ++v) {
            if (i = e[v], i < 127 && n) {
              const e = n[String.fromCharCode(i)];
              e && (i = e.charCodeAt(0));
            }
            const t = this._unicodeService.charProperties(i, g);
            r = p.UnicodeService.extractWidth(t);
            const s = p.UnicodeService.extractShouldJoin(t), m = s ? p.UnicodeService.extractWidth(g) : 0;
            if (g = t, o && this._onA11yChar.fire((0, c.stringFromCodePoint)(i)), this._getCurrentLinkId() && this._oscLinkService.addLineToLink(this._getCurrentLinkId(), this._activeBuffer.ybase + this._activeBuffer.y), this._activeBuffer.x + r - m > a) {
              if (h) {
                const e = _;
                let t = this._activeBuffer.x - m;
                for (this._activeBuffer.x = m, this._activeBuffer.y++, this._activeBuffer.y === this._activeBuffer.scrollBottom + 1 ? (this._activeBuffer.y--, this._bufferService.scroll(this._eraseAttrData(), true)) : (this._activeBuffer.y >= this._bufferService.rows && (this._activeBuffer.y = this._bufferService.rows - 1), this._activeBuffer.lines.get(this._activeBuffer.ybase + this._activeBuffer.y).isWrapped = true), _ = this._activeBuffer.lines.get(this._activeBuffer.ybase + this._activeBuffer.y), m > 0 && _ instanceof l.BufferLine && _.copyCellsFrom(e, t, 0, m, false);t < a; )
                  e.setCellFromCodepoint(t++, 0, 1, f);
              } else if (this._activeBuffer.x = a - 1, r === 2)
                continue;
            }
            if (s && this._activeBuffer.x) {
              const e = _.getWidth(this._activeBuffer.x - 1) ? 1 : 2;
              _.addCodepointToCell(this._activeBuffer.x - e, i, r);
              for (let e = r - m;--e >= 0; )
                _.setCellFromCodepoint(this._activeBuffer.x++, 0, 0, f);
            } else if (d && (_.insertCells(this._activeBuffer.x, r - m, this._activeBuffer.getNullCell(f)), _.getWidth(a - 1) === 2 && _.setCellFromCodepoint(a - 1, u.NULL_CELL_CODE, u.NULL_CELL_WIDTH, f)), _.setCellFromCodepoint(this._activeBuffer.x++, i, r, f), r > 0)
              for (;--r; )
                _.setCellFromCodepoint(this._activeBuffer.x++, 0, 0, f);
          }
          this._parser.precedingJoinState = g, this._activeBuffer.x < a && s - t > 0 && _.getWidth(this._activeBuffer.x) === 0 && !_.hasContent(this._activeBuffer.x) && _.setCellFromCodepoint(this._activeBuffer.x, 0, 1, f), this._dirtyRowTracker.markDirty(this._activeBuffer.y);
        }
        registerCsiHandler(e, t) {
          return e.final !== "t" || e.prefix || e.intermediates ? this._parser.registerCsiHandler(e, t) : this._parser.registerCsiHandler(e, (e) => !C(e.params[0], this._optionsService.rawOptions.windowOptions) || t(e));
        }
        registerDcsHandler(e, t) {
          return this._parser.registerDcsHandler(e, new v.DcsHandler(t));
        }
        registerEscHandler(e, t) {
          return this._parser.registerEscHandler(e, t);
        }
        registerOscHandler(e, t) {
          return this._parser.registerOscHandler(e, new g.OscHandler(t));
        }
        bell() {
          return this._onRequestBell.fire(), true;
        }
        lineFeed() {
          return this._dirtyRowTracker.markDirty(this._activeBuffer.y), this._optionsService.rawOptions.convertEol && (this._activeBuffer.x = 0), this._activeBuffer.y++, this._activeBuffer.y === this._activeBuffer.scrollBottom + 1 ? (this._activeBuffer.y--, this._bufferService.scroll(this._eraseAttrData())) : this._activeBuffer.y >= this._bufferService.rows ? this._activeBuffer.y = this._bufferService.rows - 1 : this._activeBuffer.lines.get(this._activeBuffer.ybase + this._activeBuffer.y).isWrapped = false, this._activeBuffer.x >= this._bufferService.cols && this._activeBuffer.x--, this._dirtyRowTracker.markDirty(this._activeBuffer.y), this._onLineFeed.fire(), true;
        }
        carriageReturn() {
          return this._activeBuffer.x = 0, true;
        }
        backspace() {
          if (!this._coreService.decPrivateModes.reverseWraparound)
            return this._restrictCursor(), this._activeBuffer.x > 0 && this._activeBuffer.x--, true;
          if (this._restrictCursor(this._bufferService.cols), this._activeBuffer.x > 0)
            this._activeBuffer.x--;
          else if (this._activeBuffer.x === 0 && this._activeBuffer.y > this._activeBuffer.scrollTop && this._activeBuffer.y <= this._activeBuffer.scrollBottom && this._activeBuffer.lines.get(this._activeBuffer.ybase + this._activeBuffer.y)?.isWrapped) {
            this._activeBuffer.lines.get(this._activeBuffer.ybase + this._activeBuffer.y).isWrapped = false, this._activeBuffer.y--, this._activeBuffer.x = this._bufferService.cols - 1;
            const e = this._activeBuffer.lines.get(this._activeBuffer.ybase + this._activeBuffer.y);
            e.hasWidth(this._activeBuffer.x) && !e.hasContent(this._activeBuffer.x) && this._activeBuffer.x--;
          }
          return this._restrictCursor(), true;
        }
        tab() {
          if (this._activeBuffer.x >= this._bufferService.cols)
            return true;
          const e = this._activeBuffer.x;
          return this._activeBuffer.x = this._activeBuffer.nextStop(), this._optionsService.rawOptions.screenReaderMode && this._onA11yTab.fire(this._activeBuffer.x - e), true;
        }
        shiftOut() {
          return this._charsetService.setgLevel(1), true;
        }
        shiftIn() {
          return this._charsetService.setgLevel(0), true;
        }
        _restrictCursor(e = this._bufferService.cols - 1) {
          this._activeBuffer.x = Math.min(e, Math.max(0, this._activeBuffer.x)), this._activeBuffer.y = this._coreService.decPrivateModes.origin ? Math.min(this._activeBuffer.scrollBottom, Math.max(this._activeBuffer.scrollTop, this._activeBuffer.y)) : Math.min(this._bufferService.rows - 1, Math.max(0, this._activeBuffer.y)), this._dirtyRowTracker.markDirty(this._activeBuffer.y);
        }
        _setCursor(e, t) {
          this._dirtyRowTracker.markDirty(this._activeBuffer.y), this._coreService.decPrivateModes.origin ? (this._activeBuffer.x = e, this._activeBuffer.y = this._activeBuffer.scrollTop + t) : (this._activeBuffer.x = e, this._activeBuffer.y = t), this._restrictCursor(), this._dirtyRowTracker.markDirty(this._activeBuffer.y);
        }
        _moveCursor(e, t) {
          this._restrictCursor(), this._setCursor(this._activeBuffer.x + e, this._activeBuffer.y + t);
        }
        cursorUp(e) {
          const t = this._activeBuffer.y - this._activeBuffer.scrollTop;
          return t >= 0 ? this._moveCursor(0, -Math.min(t, e.params[0] || 1)) : this._moveCursor(0, -(e.params[0] || 1)), true;
        }
        cursorDown(e) {
          const t = this._activeBuffer.scrollBottom - this._activeBuffer.y;
          return t >= 0 ? this._moveCursor(0, Math.min(t, e.params[0] || 1)) : this._moveCursor(0, e.params[0] || 1), true;
        }
        cursorForward(e) {
          return this._moveCursor(e.params[0] || 1, 0), true;
        }
        cursorBackward(e) {
          return this._moveCursor(-(e.params[0] || 1), 0), true;
        }
        cursorNextLine(e) {
          return this.cursorDown(e), this._activeBuffer.x = 0, true;
        }
        cursorPrecedingLine(e) {
          return this.cursorUp(e), this._activeBuffer.x = 0, true;
        }
        cursorCharAbsolute(e) {
          return this._setCursor((e.params[0] || 1) - 1, this._activeBuffer.y), true;
        }
        cursorPosition(e) {
          return this._setCursor(e.length >= 2 ? (e.params[1] || 1) - 1 : 0, (e.params[0] || 1) - 1), true;
        }
        charPosAbsolute(e) {
          return this._setCursor((e.params[0] || 1) - 1, this._activeBuffer.y), true;
        }
        hPositionRelative(e) {
          return this._moveCursor(e.params[0] || 1, 0), true;
        }
        linePosAbsolute(e) {
          return this._setCursor(this._activeBuffer.x, (e.params[0] || 1) - 1), true;
        }
        vPositionRelative(e) {
          return this._moveCursor(0, e.params[0] || 1), true;
        }
        hVPosition(e) {
          return this.cursorPosition(e), true;
        }
        tabClear(e) {
          const t = e.params[0];
          return t === 0 ? delete this._activeBuffer.tabs[this._activeBuffer.x] : t === 3 && (this._activeBuffer.tabs = {}), true;
        }
        cursorForwardTab(e) {
          if (this._activeBuffer.x >= this._bufferService.cols)
            return true;
          let t = e.params[0] || 1;
          for (;t--; )
            this._activeBuffer.x = this._activeBuffer.nextStop();
          return true;
        }
        cursorBackwardTab(e) {
          if (this._activeBuffer.x >= this._bufferService.cols)
            return true;
          let t = e.params[0] || 1;
          for (;t--; )
            this._activeBuffer.x = this._activeBuffer.prevStop();
          return true;
        }
        selectProtected(e) {
          const t = e.params[0];
          return t === 1 && (this._curAttrData.bg |= 536870912), t !== 2 && t !== 0 || (this._curAttrData.bg &= -536870913), true;
        }
        _eraseInBufferLine(e, t, s, i = false, r = false) {
          const n = this._activeBuffer.lines.get(this._activeBuffer.ybase + e);
          n.replaceCells(t, s, this._activeBuffer.getNullCell(this._eraseAttrData()), r), i && (n.isWrapped = false);
        }
        _resetBufferLine(e, t = false) {
          const s = this._activeBuffer.lines.get(this._activeBuffer.ybase + e);
          s && (s.fill(this._activeBuffer.getNullCell(this._eraseAttrData()), t), this._bufferService.buffer.clearMarkers(this._activeBuffer.ybase + e), s.isWrapped = false);
        }
        eraseInDisplay(e, t = false) {
          let s;
          switch (this._restrictCursor(this._bufferService.cols), e.params[0]) {
            case 0:
              for (s = this._activeBuffer.y, this._dirtyRowTracker.markDirty(s), this._eraseInBufferLine(s++, this._activeBuffer.x, this._bufferService.cols, this._activeBuffer.x === 0, t);s < this._bufferService.rows; s++)
                this._resetBufferLine(s, t);
              this._dirtyRowTracker.markDirty(s);
              break;
            case 1:
              for (s = this._activeBuffer.y, this._dirtyRowTracker.markDirty(s), this._eraseInBufferLine(s, 0, this._activeBuffer.x + 1, true, t), this._activeBuffer.x + 1 >= this._bufferService.cols && (this._activeBuffer.lines.get(s + 1).isWrapped = false);s--; )
                this._resetBufferLine(s, t);
              this._dirtyRowTracker.markDirty(0);
              break;
            case 2:
              if (this._optionsService.rawOptions.scrollOnEraseInDisplay) {
                for (s = this._bufferService.rows, this._dirtyRowTracker.markRangeDirty(0, s - 1);s--; ) {
                  const e = this._activeBuffer.lines.get(this._activeBuffer.ybase + s);
                  if (e?.getTrimmedLength())
                    break;
                }
                for (;s >= 0; s--)
                  this._bufferService.scroll(this._eraseAttrData());
              } else {
                for (s = this._bufferService.rows, this._dirtyRowTracker.markDirty(s - 1);s--; )
                  this._resetBufferLine(s, t);
                this._dirtyRowTracker.markDirty(0);
              }
              break;
            case 3:
              const e = this._activeBuffer.lines.length - this._bufferService.rows;
              e > 0 && (this._activeBuffer.lines.trimStart(e), this._activeBuffer.ybase = Math.max(this._activeBuffer.ybase - e, 0), this._activeBuffer.ydisp = Math.max(this._activeBuffer.ydisp - e, 0), this._onScroll.fire(0));
          }
          return true;
        }
        eraseInLine(e, t = false) {
          switch (this._restrictCursor(this._bufferService.cols), e.params[0]) {
            case 0:
              this._eraseInBufferLine(this._activeBuffer.y, this._activeBuffer.x, this._bufferService.cols, this._activeBuffer.x === 0, t);
              break;
            case 1:
              this._eraseInBufferLine(this._activeBuffer.y, 0, this._activeBuffer.x + 1, false, t);
              break;
            case 2:
              this._eraseInBufferLine(this._activeBuffer.y, 0, this._bufferService.cols, true, t);
          }
          return this._dirtyRowTracker.markDirty(this._activeBuffer.y), true;
        }
        insertLines(e) {
          this._restrictCursor();
          let t = e.params[0] || 1;
          if (this._activeBuffer.y > this._activeBuffer.scrollBottom || this._activeBuffer.y < this._activeBuffer.scrollTop)
            return true;
          const s = this._activeBuffer.ybase + this._activeBuffer.y, i = this._bufferService.rows - 1 - this._activeBuffer.scrollBottom, r = this._bufferService.rows - 1 + this._activeBuffer.ybase - i + 1;
          for (;t--; )
            this._activeBuffer.lines.splice(r - 1, 1), this._activeBuffer.lines.splice(s, 0, this._activeBuffer.getBlankLine(this._eraseAttrData()));
          return this._dirtyRowTracker.markRangeDirty(this._activeBuffer.y, this._activeBuffer.scrollBottom), this._activeBuffer.x = 0, true;
        }
        deleteLines(e) {
          this._restrictCursor();
          let t = e.params[0] || 1;
          if (this._activeBuffer.y > this._activeBuffer.scrollBottom || this._activeBuffer.y < this._activeBuffer.scrollTop)
            return true;
          const s = this._activeBuffer.ybase + this._activeBuffer.y;
          let i;
          for (i = this._bufferService.rows - 1 - this._activeBuffer.scrollBottom, i = this._bufferService.rows - 1 + this._activeBuffer.ybase - i;t--; )
            this._activeBuffer.lines.splice(s, 1), this._activeBuffer.lines.splice(i, 0, this._activeBuffer.getBlankLine(this._eraseAttrData()));
          return this._dirtyRowTracker.markRangeDirty(this._activeBuffer.y, this._activeBuffer.scrollBottom), this._activeBuffer.x = 0, true;
        }
        insertChars(e) {
          this._restrictCursor();
          const t = this._activeBuffer.lines.get(this._activeBuffer.ybase + this._activeBuffer.y);
          return t && (t.insertCells(this._activeBuffer.x, e.params[0] || 1, this._activeBuffer.getNullCell(this._eraseAttrData())), this._dirtyRowTracker.markDirty(this._activeBuffer.y)), true;
        }
        deleteChars(e) {
          this._restrictCursor();
          const t = this._activeBuffer.lines.get(this._activeBuffer.ybase + this._activeBuffer.y);
          return t && (t.deleteCells(this._activeBuffer.x, e.params[0] || 1, this._activeBuffer.getNullCell(this._eraseAttrData())), this._dirtyRowTracker.markDirty(this._activeBuffer.y)), true;
        }
        scrollUp(e) {
          let t = e.params[0] || 1;
          for (;t--; )
            this._activeBuffer.lines.splice(this._activeBuffer.ybase + this._activeBuffer.scrollTop, 1), this._activeBuffer.lines.splice(this._activeBuffer.ybase + this._activeBuffer.scrollBottom, 0, this._activeBuffer.getBlankLine(this._eraseAttrData()));
          return this._dirtyRowTracker.markRangeDirty(this._activeBuffer.scrollTop, this._activeBuffer.scrollBottom), true;
        }
        scrollDown(e) {
          let t = e.params[0] || 1;
          for (;t--; )
            this._activeBuffer.lines.splice(this._activeBuffer.ybase + this._activeBuffer.scrollBottom, 1), this._activeBuffer.lines.splice(this._activeBuffer.ybase + this._activeBuffer.scrollTop, 0, this._activeBuffer.getBlankLine(l.DEFAULT_ATTR_DATA));
          return this._dirtyRowTracker.markRangeDirty(this._activeBuffer.scrollTop, this._activeBuffer.scrollBottom), true;
        }
        scrollLeft(e) {
          if (this._activeBuffer.y > this._activeBuffer.scrollBottom || this._activeBuffer.y < this._activeBuffer.scrollTop)
            return true;
          const t = e.params[0] || 1;
          for (let e = this._activeBuffer.scrollTop;e <= this._activeBuffer.scrollBottom; ++e) {
            const s = this._activeBuffer.lines.get(this._activeBuffer.ybase + e);
            s.deleteCells(0, t, this._activeBuffer.getNullCell(this._eraseAttrData())), s.isWrapped = false;
          }
          return this._dirtyRowTracker.markRangeDirty(this._activeBuffer.scrollTop, this._activeBuffer.scrollBottom), true;
        }
        scrollRight(e) {
          if (this._activeBuffer.y > this._activeBuffer.scrollBottom || this._activeBuffer.y < this._activeBuffer.scrollTop)
            return true;
          const t = e.params[0] || 1;
          for (let e = this._activeBuffer.scrollTop;e <= this._activeBuffer.scrollBottom; ++e) {
            const s = this._activeBuffer.lines.get(this._activeBuffer.ybase + e);
            s.insertCells(0, t, this._activeBuffer.getNullCell(this._eraseAttrData())), s.isWrapped = false;
          }
          return this._dirtyRowTracker.markRangeDirty(this._activeBuffer.scrollTop, this._activeBuffer.scrollBottom), true;
        }
        insertColumns(e) {
          if (this._activeBuffer.y > this._activeBuffer.scrollBottom || this._activeBuffer.y < this._activeBuffer.scrollTop)
            return true;
          const t = e.params[0] || 1;
          for (let e = this._activeBuffer.scrollTop;e <= this._activeBuffer.scrollBottom; ++e) {
            const s = this._activeBuffer.lines.get(this._activeBuffer.ybase + e);
            s.insertCells(this._activeBuffer.x, t, this._activeBuffer.getNullCell(this._eraseAttrData())), s.isWrapped = false;
          }
          return this._dirtyRowTracker.markRangeDirty(this._activeBuffer.scrollTop, this._activeBuffer.scrollBottom), true;
        }
        deleteColumns(e) {
          if (this._activeBuffer.y > this._activeBuffer.scrollBottom || this._activeBuffer.y < this._activeBuffer.scrollTop)
            return true;
          const t = e.params[0] || 1;
          for (let e = this._activeBuffer.scrollTop;e <= this._activeBuffer.scrollBottom; ++e) {
            const s = this._activeBuffer.lines.get(this._activeBuffer.ybase + e);
            s.deleteCells(this._activeBuffer.x, t, this._activeBuffer.getNullCell(this._eraseAttrData())), s.isWrapped = false;
          }
          return this._dirtyRowTracker.markRangeDirty(this._activeBuffer.scrollTop, this._activeBuffer.scrollBottom), true;
        }
        eraseChars(e) {
          this._restrictCursor();
          const t = this._activeBuffer.lines.get(this._activeBuffer.ybase + this._activeBuffer.y);
          return t && (t.replaceCells(this._activeBuffer.x, this._activeBuffer.x + (e.params[0] || 1), this._activeBuffer.getNullCell(this._eraseAttrData())), this._dirtyRowTracker.markDirty(this._activeBuffer.y)), true;
        }
        repeatPrecedingCharacter(e) {
          const t = this._parser.precedingJoinState;
          if (!t)
            return true;
          const s = e.params[0] || 1, i = p.UnicodeService.extractWidth(t), r = this._activeBuffer.x - i, n = this._activeBuffer.lines.get(this._activeBuffer.ybase + this._activeBuffer.y).getString(r), o = new Uint32Array(n.length * s);
          let a = 0;
          for (let e = 0;e < n.length; ) {
            const t = n.codePointAt(e) || 0;
            o[a++] = t, e += t > 65535 ? 2 : 1;
          }
          let h = a;
          for (let e = 1;e < s; ++e)
            o.copyWithin(h, 0, a), h += a;
          return this.print(o, 0, h), true;
        }
        sendDeviceAttributesPrimary(e) {
          return e.params[0] > 0 || (this._is("xterm") || this._is("rxvt-unicode") || this._is("screen") ? this._coreService.triggerDataEvent(n.C0.ESC + "[?1;2c") : this._is("linux") && this._coreService.triggerDataEvent(n.C0.ESC + "[?6c")), true;
        }
        sendDeviceAttributesSecondary(e) {
          return e.params[0] > 0 || (this._is("xterm") ? this._coreService.triggerDataEvent(n.C0.ESC + "[>0;276;0c") : this._is("rxvt-unicode") ? this._coreService.triggerDataEvent(n.C0.ESC + "[>85;95;0c") : this._is("linux") ? this._coreService.triggerDataEvent(e.params[0] + "c") : this._is("screen") && this._coreService.triggerDataEvent(n.C0.ESC + "[>83;40003;0c")), true;
        }
        _is(e) {
          return (this._optionsService.rawOptions.termName + "").indexOf(e) === 0;
        }
        setMode(e) {
          for (let t = 0;t < e.length; t++)
            switch (e.params[t]) {
              case 4:
                this._coreService.modes.insertMode = true;
                break;
              case 20:
                this._optionsService.options.convertEol = true;
            }
          return true;
        }
        setModePrivate(e) {
          for (let t = 0;t < e.length; t++)
            switch (e.params[t]) {
              case 1:
                this._coreService.decPrivateModes.applicationCursorKeys = true;
                break;
              case 2:
                this._charsetService.setgCharset(0, o.DEFAULT_CHARSET), this._charsetService.setgCharset(1, o.DEFAULT_CHARSET), this._charsetService.setgCharset(2, o.DEFAULT_CHARSET), this._charsetService.setgCharset(3, o.DEFAULT_CHARSET);
                break;
              case 3:
                this._optionsService.rawOptions.windowOptions.setWinLines && (this._bufferService.resize(132, this._bufferService.rows), this._onRequestReset.fire());
                break;
              case 6:
                this._coreService.decPrivateModes.origin = true, this._setCursor(0, 0);
                break;
              case 7:
                this._coreService.decPrivateModes.wraparound = true;
                break;
              case 12:
                this._optionsService.options.cursorBlink = true;
                break;
              case 45:
                this._coreService.decPrivateModes.reverseWraparound = true;
                break;
              case 66:
                this._logService.debug("Serial port requested application keypad."), this._coreService.decPrivateModes.applicationKeypad = true, this._onRequestSyncScrollBar.fire();
                break;
              case 9:
                this._coreMouseService.activeProtocol = "X10";
                break;
              case 1000:
                this._coreMouseService.activeProtocol = "VT200";
                break;
              case 1002:
                this._coreMouseService.activeProtocol = "DRAG";
                break;
              case 1003:
                this._coreMouseService.activeProtocol = "ANY";
                break;
              case 1004:
                this._coreService.decPrivateModes.sendFocus = true, this._onRequestSendFocus.fire();
                break;
              case 1005:
                this._logService.debug("DECSET 1005 not supported (see #2507)");
                break;
              case 1006:
                this._coreMouseService.activeEncoding = "SGR";
                break;
              case 1015:
                this._logService.debug("DECSET 1015 not supported (see #2507)");
                break;
              case 1016:
                this._coreMouseService.activeEncoding = "SGR_PIXELS";
                break;
              case 25:
                this._coreService.isCursorHidden = false;
                break;
              case 1048:
                this.saveCursor();
                break;
              case 1049:
                this.saveCursor();
              case 47:
              case 1047:
                this._bufferService.buffers.activateAltBuffer(this._eraseAttrData()), this._coreService.isCursorInitialized = true, this._onRequestRefreshRows.fire(undefined), this._onRequestSyncScrollBar.fire();
                break;
              case 2004:
                this._coreService.decPrivateModes.bracketedPasteMode = true;
                break;
              case 2026:
                this._coreService.decPrivateModes.synchronizedOutput = true;
            }
          return true;
        }
        resetMode(e) {
          for (let t = 0;t < e.length; t++)
            switch (e.params[t]) {
              case 4:
                this._coreService.modes.insertMode = false;
                break;
              case 20:
                this._optionsService.options.convertEol = false;
            }
          return true;
        }
        resetModePrivate(e) {
          for (let t = 0;t < e.length; t++)
            switch (e.params[t]) {
              case 1:
                this._coreService.decPrivateModes.applicationCursorKeys = false;
                break;
              case 3:
                this._optionsService.rawOptions.windowOptions.setWinLines && (this._bufferService.resize(80, this._bufferService.rows), this._onRequestReset.fire());
                break;
              case 6:
                this._coreService.decPrivateModes.origin = false, this._setCursor(0, 0);
                break;
              case 7:
                this._coreService.decPrivateModes.wraparound = false;
                break;
              case 12:
                this._optionsService.options.cursorBlink = false;
                break;
              case 45:
                this._coreService.decPrivateModes.reverseWraparound = false;
                break;
              case 66:
                this._logService.debug("Switching back to normal keypad."), this._coreService.decPrivateModes.applicationKeypad = false, this._onRequestSyncScrollBar.fire();
                break;
              case 9:
              case 1000:
              case 1002:
              case 1003:
                this._coreMouseService.activeProtocol = "NONE";
                break;
              case 1004:
                this._coreService.decPrivateModes.sendFocus = false;
                break;
              case 1005:
                this._logService.debug("DECRST 1005 not supported (see #2507)");
                break;
              case 1006:
              case 1016:
                this._coreMouseService.activeEncoding = "DEFAULT";
                break;
              case 1015:
                this._logService.debug("DECRST 1015 not supported (see #2507)");
                break;
              case 25:
                this._coreService.isCursorHidden = true;
                break;
              case 1048:
                this.restoreCursor();
                break;
              case 1049:
              case 47:
              case 1047:
                this._bufferService.buffers.activateNormalBuffer(), e.params[t] === 1049 && this.restoreCursor(), this._coreService.isCursorInitialized = true, this._onRequestRefreshRows.fire(undefined), this._onRequestSyncScrollBar.fire();
                break;
              case 2004:
                this._coreService.decPrivateModes.bracketedPasteMode = false;
                break;
              case 2026:
                this._coreService.decPrivateModes.synchronizedOutput = false, this._onRequestRefreshRows.fire(undefined);
            }
          return true;
        }
        requestMode(e, t) {
          const s = this._coreService.decPrivateModes, { activeProtocol: i, activeEncoding: r } = this._coreMouseService, o = this._coreService, { buffers: a, cols: h } = this._bufferService, { active: c, alt: l } = a, u = this._optionsService.rawOptions, d = (e) => e ? 1 : 2, f = e.params[0];
          return _ = f, p = t ? f === 2 ? 4 : f === 4 ? d(o.modes.insertMode) : f === 12 ? 3 : f === 20 ? d(u.convertEol) : 0 : f === 1 ? d(s.applicationCursorKeys) : f === 3 ? u.windowOptions.setWinLines ? h === 80 ? 2 : h === 132 ? 1 : 0 : 0 : f === 6 ? d(s.origin) : f === 7 ? d(s.wraparound) : f === 8 ? 3 : f === 9 ? d(i === "X10") : f === 12 ? d(u.cursorBlink) : f === 25 ? d(!o.isCursorHidden) : f === 45 ? d(s.reverseWraparound) : f === 66 ? d(s.applicationKeypad) : f === 67 ? 4 : f === 1000 ? d(i === "VT200") : f === 1002 ? d(i === "DRAG") : f === 1003 ? d(i === "ANY") : f === 1004 ? d(s.sendFocus) : f === 1005 ? 4 : f === 1006 ? d(r === "SGR") : f === 1015 ? 4 : f === 1016 ? d(r === "SGR_PIXELS") : f === 1048 ? 1 : f === 47 || f === 1047 || f === 1049 ? d(c === l) : f === 2004 ? d(s.bracketedPasteMode) : f === 2026 ? d(s.synchronizedOutput) : 0, o.triggerDataEvent(`${n.C0.ESC}[${t ? "" : "?"}${_};${p}$y`), true;
          var _, p;
        }
        _updateAttrColor(e, t, s, i, r) {
          return t === 2 ? (e |= 50331648, e &= -16777216, e |= f.AttributeData.fromColorRGB([s, i, r])) : t === 5 && (e &= -50331904, e |= 33554432 | 255 & s), e;
        }
        _extractColor(e, t, s) {
          const i = [0, 0, -1, 0, 0, 0];
          let r = 0, n = 0;
          do {
            if (i[n + r] = e.params[t + n], e.hasSubParams(t + n)) {
              const s = e.getSubParams(t + n);
              let o = 0;
              do {
                i[1] === 5 && (r = 1), i[n + o + 1 + r] = s[o];
              } while (++o < s.length && o + n + 1 + r < i.length);
              break;
            }
            if (i[1] === 5 && n + r >= 2 || i[1] === 2 && n + r >= 5)
              break;
            i[1] && (r = 1);
          } while (++n + t < e.length && n + r < i.length);
          for (let e = 2;e < i.length; ++e)
            i[e] === -1 && (i[e] = 0);
          switch (i[0]) {
            case 38:
              s.fg = this._updateAttrColor(s.fg, i[1], i[3], i[4], i[5]);
              break;
            case 48:
              s.bg = this._updateAttrColor(s.bg, i[1], i[3], i[4], i[5]);
              break;
            case 58:
              s.extended = s.extended.clone(), s.extended.underlineColor = this._updateAttrColor(s.extended.underlineColor, i[1], i[3], i[4], i[5]);
          }
          return n;
        }
        _processUnderline(e, t) {
          t.extended = t.extended.clone(), (!~e || e > 5) && (e = 1), t.extended.underlineStyle = e, t.fg |= 268435456, e === 0 && (t.fg &= -268435457), t.updateExtended();
        }
        _processSGR0(e) {
          e.fg = l.DEFAULT_ATTR_DATA.fg, e.bg = l.DEFAULT_ATTR_DATA.bg, e.extended = e.extended.clone(), e.extended.underlineStyle = 0, e.extended.underlineColor &= -67108864, e.updateExtended();
        }
        charAttributes(e) {
          if (e.length === 1 && e.params[0] === 0)
            return this._processSGR0(this._curAttrData), true;
          const t = e.length;
          let s;
          const i = this._curAttrData;
          for (let r = 0;r < t; r++)
            s = e.params[r], s >= 30 && s <= 37 ? (i.fg &= -50331904, i.fg |= 16777216 | s - 30) : s >= 40 && s <= 47 ? (i.bg &= -50331904, i.bg |= 16777216 | s - 40) : s >= 90 && s <= 97 ? (i.fg &= -50331904, i.fg |= 16777224 | s - 90) : s >= 100 && s <= 107 ? (i.bg &= -50331904, i.bg |= 16777224 | s - 100) : s === 0 ? this._processSGR0(i) : s === 1 ? i.fg |= 134217728 : s === 3 ? i.bg |= 67108864 : s === 4 ? (i.fg |= 268435456, this._processUnderline(e.hasSubParams(r) ? e.getSubParams(r)[0] : 1, i)) : s === 5 ? i.fg |= 536870912 : s === 7 ? i.fg |= 67108864 : s === 8 ? i.fg |= 1073741824 : s === 9 ? i.fg |= 2147483648 : s === 2 ? i.bg |= 134217728 : s === 21 ? this._processUnderline(2, i) : s === 22 ? (i.fg &= -134217729, i.bg &= -134217729) : s === 23 ? i.bg &= -67108865 : s === 24 ? (i.fg &= -268435457, this._processUnderline(0, i)) : s === 25 ? i.fg &= -536870913 : s === 27 ? i.fg &= -67108865 : s === 28 ? i.fg &= -1073741825 : s === 29 ? i.fg &= 2147483647 : s === 39 ? (i.fg &= -67108864, i.fg |= 16777215 & l.DEFAULT_ATTR_DATA.fg) : s === 49 ? (i.bg &= -67108864, i.bg |= 16777215 & l.DEFAULT_ATTR_DATA.bg) : s === 38 || s === 48 || s === 58 ? r += this._extractColor(e, r, i) : s === 53 ? i.bg |= 1073741824 : s === 55 ? i.bg &= -1073741825 : s === 59 ? (i.extended = i.extended.clone(), i.extended.underlineColor = -1, i.updateExtended()) : s === 100 ? (i.fg &= -67108864, i.fg |= 16777215 & l.DEFAULT_ATTR_DATA.fg, i.bg &= -67108864, i.bg |= 16777215 & l.DEFAULT_ATTR_DATA.bg) : this._logService.debug("Unknown SGR attribute: %d.", s);
          return true;
        }
        deviceStatus(e) {
          switch (e.params[0]) {
            case 5:
              this._coreService.triggerDataEvent(`${n.C0.ESC}[0n`);
              break;
            case 6:
              const e = this._activeBuffer.y + 1, t = this._activeBuffer.x + 1;
              this._coreService.triggerDataEvent(`${n.C0.ESC}[${e};${t}R`);
          }
          return true;
        }
        deviceStatusPrivate(e) {
          if (e.params[0] === 6) {
            const e = this._activeBuffer.y + 1, t = this._activeBuffer.x + 1;
            this._coreService.triggerDataEvent(`${n.C0.ESC}[?${e};${t}R`);
          }
          return true;
        }
        softReset(e) {
          return this._coreService.isCursorHidden = false, this._onRequestSyncScrollBar.fire(), this._activeBuffer.scrollTop = 0, this._activeBuffer.scrollBottom = this._bufferService.rows - 1, this._curAttrData = l.DEFAULT_ATTR_DATA.clone(), this._coreService.reset(), this._charsetService.reset(), this._activeBuffer.savedX = 0, this._activeBuffer.savedY = this._activeBuffer.ybase, this._activeBuffer.savedCurAttrData.fg = this._curAttrData.fg, this._activeBuffer.savedCurAttrData.bg = this._curAttrData.bg, this._activeBuffer.savedCharset = this._charsetService.charset, this._coreService.decPrivateModes.origin = false, true;
        }
        setCursorStyle(e) {
          const t = e.length === 0 ? 1 : e.params[0];
          if (t === 0)
            this._coreService.decPrivateModes.cursorStyle = undefined, this._coreService.decPrivateModes.cursorBlink = undefined;
          else {
            switch (t) {
              case 1:
              case 2:
                this._coreService.decPrivateModes.cursorStyle = "block";
                break;
              case 3:
              case 4:
                this._coreService.decPrivateModes.cursorStyle = "underline";
                break;
              case 5:
              case 6:
                this._coreService.decPrivateModes.cursorStyle = "bar";
            }
            const e = t % 2 == 1;
            this._coreService.decPrivateModes.cursorBlink = e;
          }
          return true;
        }
        setScrollRegion(e) {
          const t = e.params[0] || 1;
          let s;
          return (e.length < 2 || (s = e.params[1]) > this._bufferService.rows || s === 0) && (s = this._bufferService.rows), s > t && (this._activeBuffer.scrollTop = t - 1, this._activeBuffer.scrollBottom = s - 1, this._setCursor(0, 0)), true;
        }
        windowOptions(e) {
          if (!C(e.params[0], this._optionsService.rawOptions.windowOptions))
            return true;
          const t = e.length > 1 ? e.params[1] : 0;
          switch (e.params[0]) {
            case 14:
              t !== 2 && this._onRequestWindowsOptionsReport.fire(w.GET_WIN_SIZE_PIXELS);
              break;
            case 16:
              this._onRequestWindowsOptionsReport.fire(w.GET_CELL_SIZE_PIXELS);
              break;
            case 18:
              this._bufferService && this._coreService.triggerDataEvent(`${n.C0.ESC}[8;${this._bufferService.rows};${this._bufferService.cols}t`);
              break;
            case 22:
              t !== 0 && t !== 2 || (this._windowTitleStack.push(this._windowTitle), this._windowTitleStack.length > 10 && this._windowTitleStack.shift()), t !== 0 && t !== 1 || (this._iconNameStack.push(this._iconName), this._iconNameStack.length > 10 && this._iconNameStack.shift());
              break;
            case 23:
              t !== 0 && t !== 2 || this._windowTitleStack.length && this.setTitle(this._windowTitleStack.pop()), t !== 0 && t !== 1 || this._iconNameStack.length && this.setIconName(this._iconNameStack.pop());
          }
          return true;
        }
        saveCursor(e) {
          return this._activeBuffer.savedX = this._activeBuffer.x, this._activeBuffer.savedY = this._activeBuffer.ybase + this._activeBuffer.y, this._activeBuffer.savedCurAttrData.fg = this._curAttrData.fg, this._activeBuffer.savedCurAttrData.bg = this._curAttrData.bg, this._activeBuffer.savedCharset = this._charsetService.charset, true;
        }
        restoreCursor(e) {
          return this._activeBuffer.x = this._activeBuffer.savedX || 0, this._activeBuffer.y = Math.max(this._activeBuffer.savedY - this._activeBuffer.ybase, 0), this._curAttrData.fg = this._activeBuffer.savedCurAttrData.fg, this._curAttrData.bg = this._activeBuffer.savedCurAttrData.bg, this._charsetService.charset = this._savedCharset, this._activeBuffer.savedCharset && (this._charsetService.charset = this._activeBuffer.savedCharset), this._restrictCursor(), true;
        }
        setTitle(e) {
          return this._windowTitle = e, this._onTitleChange.fire(e), true;
        }
        setIconName(e) {
          return this._iconName = e, true;
        }
        setOrReportIndexedColor(e) {
          const t = [], s = e.split(";");
          for (;s.length > 1; ) {
            const e = s.shift(), i = s.shift();
            if (/^\d+$/.exec(e)) {
              const s = parseInt(e);
              if (k(s))
                if (i === "?")
                  t.push({ type: 0, index: s });
                else {
                  const e = (0, m.parseColor)(i);
                  e && t.push({ type: 1, index: s, color: e });
                }
            }
          }
          return t.length && this._onColor.fire(t), true;
        }
        setHyperlink(e) {
          const t = e.indexOf(";");
          if (t === -1)
            return true;
          const s = e.slice(0, t).trim(), i = e.slice(t + 1);
          return i ? this._createHyperlink(s, i) : !s.trim() && this._finishHyperlink();
        }
        _createHyperlink(e, t) {
          this._getCurrentLinkId() && this._finishHyperlink();
          const s = e.split(":");
          let i;
          const r = s.findIndex((e) => e.startsWith("id="));
          return r !== -1 && (i = s[r].slice(3) || undefined), this._curAttrData.extended = this._curAttrData.extended.clone(), this._curAttrData.extended.urlId = this._oscLinkService.registerLink({ id: i, uri: t }), this._curAttrData.updateExtended(), true;
        }
        _finishHyperlink() {
          return this._curAttrData.extended = this._curAttrData.extended.clone(), this._curAttrData.extended.urlId = 0, this._curAttrData.updateExtended(), true;
        }
        _setOrReportSpecialColor(e, t) {
          const s = e.split(";");
          for (let e = 0;e < s.length && !(t >= this._specialColors.length); ++e, ++t)
            if (s[e] === "?")
              this._onColor.fire([{ type: 0, index: this._specialColors[t] }]);
            else {
              const i = (0, m.parseColor)(s[e]);
              i && this._onColor.fire([{ type: 1, index: this._specialColors[t], color: i }]);
            }
          return true;
        }
        setOrReportFgColor(e) {
          return this._setOrReportSpecialColor(e, 0);
        }
        setOrReportBgColor(e) {
          return this._setOrReportSpecialColor(e, 1);
        }
        setOrReportCursorColor(e) {
          return this._setOrReportSpecialColor(e, 2);
        }
        restoreIndexedColor(e) {
          if (!e)
            return this._onColor.fire([{ type: 2 }]), true;
          const t = [], s = e.split(";");
          for (let e = 0;e < s.length; ++e)
            if (/^\d+$/.exec(s[e])) {
              const i = parseInt(s[e]);
              k(i) && t.push({ type: 2, index: i });
            }
          return t.length && this._onColor.fire(t), true;
        }
        restoreFgColor(e) {
          return this._onColor.fire([{ type: 2, index: 256 }]), true;
        }
        restoreBgColor(e) {
          return this._onColor.fire([{ type: 2, index: 257 }]), true;
        }
        restoreCursorColor(e) {
          return this._onColor.fire([{ type: 2, index: 258 }]), true;
        }
        nextLine() {
          return this._activeBuffer.x = 0, this.index(), true;
        }
        keypadApplicationMode() {
          return this._logService.debug("Serial port requested application keypad."), this._coreService.decPrivateModes.applicationKeypad = true, this._onRequestSyncScrollBar.fire(), true;
        }
        keypadNumericMode() {
          return this._logService.debug("Switching back to normal keypad."), this._coreService.decPrivateModes.applicationKeypad = false, this._onRequestSyncScrollBar.fire(), true;
        }
        selectDefaultCharset() {
          return this._charsetService.setgLevel(0), this._charsetService.setgCharset(0, o.DEFAULT_CHARSET), true;
        }
        selectCharset(e) {
          return e.length !== 2 ? (this.selectDefaultCharset(), true) : (e[0] === "/" || this._charsetService.setgCharset(S[e[0]], o.CHARSETS[e[1]] || o.DEFAULT_CHARSET), true);
        }
        index() {
          return this._restrictCursor(), this._activeBuffer.y++, this._activeBuffer.y === this._activeBuffer.scrollBottom + 1 ? (this._activeBuffer.y--, this._bufferService.scroll(this._eraseAttrData())) : this._activeBuffer.y >= this._bufferService.rows && (this._activeBuffer.y = this._bufferService.rows - 1), this._restrictCursor(), true;
        }
        tabSet() {
          return this._activeBuffer.tabs[this._activeBuffer.x] = true, true;
        }
        reverseIndex() {
          if (this._restrictCursor(), this._activeBuffer.y === this._activeBuffer.scrollTop) {
            const e = this._activeBuffer.scrollBottom - this._activeBuffer.scrollTop;
            this._activeBuffer.lines.shiftElements(this._activeBuffer.ybase + this._activeBuffer.y, e, 1), this._activeBuffer.lines.set(this._activeBuffer.ybase + this._activeBuffer.y, this._activeBuffer.getBlankLine(this._eraseAttrData())), this._dirtyRowTracker.markRangeDirty(this._activeBuffer.scrollTop, this._activeBuffer.scrollBottom);
          } else
            this._activeBuffer.y--, this._restrictCursor();
          return true;
        }
        fullReset() {
          return this._parser.reset(), this._onRequestReset.fire(), true;
        }
        reset() {
          this._curAttrData = l.DEFAULT_ATTR_DATA.clone(), this._eraseAttrDataInternal = l.DEFAULT_ATTR_DATA.clone();
        }
        _eraseAttrData() {
          return this._eraseAttrDataInternal.bg &= -67108864, this._eraseAttrDataInternal.bg |= 67108863 & this._curAttrData.bg, this._eraseAttrDataInternal;
        }
        setgLevel(e) {
          return this._charsetService.setgLevel(e), true;
        }
        screenAlignmentPattern() {
          const e = new d.CellData;
          e.content = 1 << 22 | 69, e.fg = this._curAttrData.fg, e.bg = this._curAttrData.bg, this._setCursor(0, 0);
          for (let t = 0;t < this._bufferService.rows; ++t) {
            const s = this._activeBuffer.ybase + this._activeBuffer.y + t, i = this._activeBuffer.lines.get(s);
            i && (i.fill(e), i.isWrapped = false);
          }
          return this._dirtyRowTracker.markAllDirty(), this._setCursor(0, 0), true;
        }
        requestStatusString(e, t) {
          const s = this._bufferService.buffer, i = this._optionsService.rawOptions;
          return ((e) => (this._coreService.triggerDataEvent(`${n.C0.ESC}${e}${n.C0.ESC}\\`), true))(e === '"q' ? `P1$r${this._curAttrData.isProtected() ? 1 : 0}"q` : e === '"p' ? 'P1$r61;1"p' : e === "r" ? `P1$r${s.scrollTop + 1};${s.scrollBottom + 1}r` : e === "m" ? "P1$r0m" : e === " q" ? `P1$r${{ block: 2, underline: 4, bar: 6 }[i.cursorStyle] - (i.cursorBlink ? 1 : 0)} q` : "P0$r");
        }
        markRangeDirty(e, t) {
          this._dirtyRowTracker.markRangeDirty(e, t);
        }
      }
      t.InputHandler = A;
      let L = class {
        constructor(e) {
          this._bufferService = e, this.clearRange();
        }
        clearRange() {
          this.start = this._bufferService.buffer.y, this.end = this._bufferService.buffer.y;
        }
        markDirty(e) {
          e < this.start ? this.start = e : e > this.end && (this.end = e);
        }
        markRangeDirty(e, t) {
          e > t && (E = e, e = t, t = E), e < this.start && (this.start = e), t > this.end && (this.end = t);
        }
        markAllDirty() {
          this.markRangeDirty(0, this._bufferService.rows - 1);
        }
      };
      function k(e) {
        return 0 <= e && e < 256;
      }
      L = i([r(0, _.IBufferService)], L);
    }, 701: (e, t) => {
      Object.defineProperty(t, "__esModule", { value: true }), t.isChromeOS = t.isLinux = t.isWindows = t.isIphone = t.isIpad = t.isMac = t.isSafari = t.isLegacyEdge = t.isFirefox = t.isNode = undefined, t.getSafariVersion = function() {
        if (!t.isSafari)
          return 0;
        const e = s.match(/Version\/(\d+)/);
        return e === null || e.length < 2 ? 0 : parseInt(e[1]);
      }, t.isNode = typeof process != "undefined" && "title" in process;
      const s = t.isNode ? "node" : navigator.userAgent, i = t.isNode ? "node" : navigator.platform;
      t.isFirefox = s.includes("Firefox"), t.isLegacyEdge = s.includes("Edge"), t.isSafari = /^((?!chrome|android).)*safari/i.test(s), t.isMac = ["Macintosh", "MacIntel", "MacPPC", "Mac68K"].includes(i), t.isIpad = i === "iPad", t.isIphone = i === "iPhone", t.isWindows = ["Windows", "Win16", "Win32", "WinCE"].includes(i), t.isLinux = i.indexOf("Linux") >= 0, t.isChromeOS = /\bCrOS\b/.test(s);
    }, 6168: (e, t, s) => {
      Object.defineProperty(t, "__esModule", { value: true }), t.DebouncedIdleTask = t.IdleTaskQueue = t.PriorityTaskQueue = undefined;
      const i = s(701);

      class r {
        constructor() {
          this._tasks = [], this._i = 0;
        }
        enqueue(e) {
          this._tasks.push(e), this._start();
        }
        flush() {
          for (;this._i < this._tasks.length; )
            this._tasks[this._i]() || this._i++;
          this.clear();
        }
        clear() {
          this._idleCallback && (this._cancelCallback(this._idleCallback), this._idleCallback = undefined), this._i = 0, this._tasks.length = 0;
        }
        _start() {
          this._idleCallback || (this._idleCallback = this._requestCallback(this._process.bind(this)));
        }
        _process(e) {
          this._idleCallback = undefined;
          let t = 0, s = 0, i = e.timeRemaining(), r = 0;
          for (;this._i < this._tasks.length; ) {
            if (t = performance.now(), this._tasks[this._i]() || this._i++, t = Math.max(1, performance.now() - t), s = Math.max(t, s), r = e.timeRemaining(), 1.5 * s > r)
              return i - t < -20 && console.warn(`task queue exceeded allotted deadline by ${Math.abs(Math.round(i - t))}ms`), void this._start();
            i = r;
          }
          this.clear();
        }
      }

      class n extends r {
        _requestCallback(e) {
          return setTimeout(() => e(this._createDeadline(16)));
        }
        _cancelCallback(e) {
          clearTimeout(e);
        }
        _createDeadline(e) {
          const t = performance.now() + e;
          return { timeRemaining: () => Math.max(0, t - performance.now()) };
        }
      }
      t.PriorityTaskQueue = n, t.IdleTaskQueue = !i.isNode && "requestIdleCallback" in window ? class extends r {
        _requestCallback(e) {
          return requestIdleCallback(e);
        }
        _cancelCallback(e) {
          cancelIdleCallback(e);
        }
      } : n, t.DebouncedIdleTask = class {
        constructor() {
          this._queue = new t.IdleTaskQueue;
        }
        set(e) {
          this._queue.clear(), this._queue.enqueue(e);
        }
        flush() {
          this._queue.flush();
        }
      };
    }, 5882: (e, t, s) => {
      Object.defineProperty(t, "__esModule", { value: true }), t.updateWindowsModeWrappedState = function(e) {
        const t = e.buffer.lines.get(e.buffer.ybase + e.buffer.y - 1), s = t?.get(e.cols - 1), r = e.buffer.lines.get(e.buffer.ybase + e.buffer.y);
        r && s && (r.isWrapped = s[i.CHAR_DATA_CODE_INDEX] !== i.NULL_CELL_CODE && s[i.CHAR_DATA_CODE_INDEX] !== i.WHITESPACE_CELL_CODE);
      };
      const i = s(8938);
    }, 5451: (e, t) => {
      Object.defineProperty(t, "__esModule", { value: true }), t.ExtendedAttrs = t.AttributeData = undefined;

      class s {
        constructor() {
          this.fg = 0, this.bg = 0, this.extended = new i;
        }
        static toColorRGB(e) {
          return [e >>> 16 & 255, e >>> 8 & 255, 255 & e];
        }
        static fromColorRGB(e) {
          return (255 & e[0]) << 16 | (255 & e[1]) << 8 | 255 & e[2];
        }
        clone() {
          const e = new s;
          return e.fg = this.fg, e.bg = this.bg, e.extended = this.extended.clone(), e;
        }
        isInverse() {
          return 67108864 & this.fg;
        }
        isBold() {
          return 134217728 & this.fg;
        }
        isUnderline() {
          return this.hasExtendedAttrs() && this.extended.underlineStyle !== 0 ? 1 : 268435456 & this.fg;
        }
        isBlink() {
          return 536870912 & this.fg;
        }
        isInvisible() {
          return 1073741824 & this.fg;
        }
        isItalic() {
          return 67108864 & this.bg;
        }
        isDim() {
          return 134217728 & this.bg;
        }
        isStrikethrough() {
          return 2147483648 & this.fg;
        }
        isProtected() {
          return 536870912 & this.bg;
        }
        isOverline() {
          return 1073741824 & this.bg;
        }
        getFgColorMode() {
          return 50331648 & this.fg;
        }
        getBgColorMode() {
          return 50331648 & this.bg;
        }
        isFgRGB() {
          return !(50331648 & ~this.fg);
        }
        isBgRGB() {
          return !(50331648 & ~this.bg);
        }
        isFgPalette() {
          return (50331648 & this.fg) == 16777216 || (50331648 & this.fg) == 33554432;
        }
        isBgPalette() {
          return (50331648 & this.bg) == 16777216 || (50331648 & this.bg) == 33554432;
        }
        isFgDefault() {
          return !(50331648 & this.fg);
        }
        isBgDefault() {
          return !(50331648 & this.bg);
        }
        isAttributeDefault() {
          return this.fg === 0 && this.bg === 0;
        }
        getFgColor() {
          switch (50331648 & this.fg) {
            case 16777216:
            case 33554432:
              return 255 & this.fg;
            case 50331648:
              return 16777215 & this.fg;
            default:
              return -1;
          }
        }
        getBgColor() {
          switch (50331648 & this.bg) {
            case 16777216:
            case 33554432:
              return 255 & this.bg;
            case 50331648:
              return 16777215 & this.bg;
            default:
              return -1;
          }
        }
        hasExtendedAttrs() {
          return 268435456 & this.bg;
        }
        updateExtended() {
          this.extended.isEmpty() ? this.bg &= -268435457 : this.bg |= 268435456;
        }
        getUnderlineColor() {
          if (268435456 & this.bg && ~this.extended.underlineColor)
            switch (50331648 & this.extended.underlineColor) {
              case 16777216:
              case 33554432:
                return 255 & this.extended.underlineColor;
              case 50331648:
                return 16777215 & this.extended.underlineColor;
              default:
                return this.getFgColor();
            }
          return this.getFgColor();
        }
        getUnderlineColorMode() {
          return 268435456 & this.bg && ~this.extended.underlineColor ? 50331648 & this.extended.underlineColor : this.getFgColorMode();
        }
        isUnderlineColorRGB() {
          return 268435456 & this.bg && ~this.extended.underlineColor ? !(50331648 & ~this.extended.underlineColor) : this.isFgRGB();
        }
        isUnderlineColorPalette() {
          return 268435456 & this.bg && ~this.extended.underlineColor ? (50331648 & this.extended.underlineColor) == 16777216 || (50331648 & this.extended.underlineColor) == 33554432 : this.isFgPalette();
        }
        isUnderlineColorDefault() {
          return 268435456 & this.bg && ~this.extended.underlineColor ? !(50331648 & this.extended.underlineColor) : this.isFgDefault();
        }
        getUnderlineStyle() {
          return 268435456 & this.fg ? 268435456 & this.bg ? this.extended.underlineStyle : 1 : 0;
        }
        getUnderlineVariantOffset() {
          return this.extended.underlineVariantOffset;
        }
      }
      t.AttributeData = s;

      class i {
        get ext() {
          return this._urlId ? -469762049 & this._ext | this.underlineStyle << 26 : this._ext;
        }
        set ext(e) {
          this._ext = e;
        }
        get underlineStyle() {
          return this._urlId ? 5 : (469762048 & this._ext) >> 26;
        }
        set underlineStyle(e) {
          this._ext &= -469762049, this._ext |= e << 26 & 469762048;
        }
        get underlineColor() {
          return 67108863 & this._ext;
        }
        set underlineColor(e) {
          this._ext &= -67108864, this._ext |= 67108863 & e;
        }
        get urlId() {
          return this._urlId;
        }
        set urlId(e) {
          this._urlId = e;
        }
        get underlineVariantOffset() {
          const e = (3758096384 & this._ext) >> 29;
          return e < 0 ? 4294967288 ^ e : e;
        }
        set underlineVariantOffset(e) {
          this._ext &= 536870911, this._ext |= e << 29 & 3758096384;
        }
        constructor(e = 0, t = 0) {
          this._ext = 0, this._urlId = 0, this._ext = e, this._urlId = t;
        }
        clone() {
          return new i(this._ext, this._urlId);
        }
        isEmpty() {
          return this.underlineStyle === 0 && this._urlId === 0;
        }
      }
      t.ExtendedAttrs = i;
    }, 1073: (e, t, s) => {
      Object.defineProperty(t, "__esModule", { value: true }), t.Buffer = t.MAX_BUFFER_SIZE = undefined;
      const i = s(5639), r = s(6168), n = s(5451), o = s(6107), a = s(732), h = s(3055), c = s(8938), l = s(8158), u = s(6760);
      t.MAX_BUFFER_SIZE = 4294967295, t.Buffer = class {
        constructor(e, t, s) {
          this._hasScrollback = e, this._optionsService = t, this._bufferService = s, this.ydisp = 0, this.ybase = 0, this.y = 0, this.x = 0, this.tabs = {}, this.savedY = 0, this.savedX = 0, this.savedCurAttrData = o.DEFAULT_ATTR_DATA.clone(), this.savedCharset = u.DEFAULT_CHARSET, this.markers = [], this._nullCell = h.CellData.fromCharData([0, c.NULL_CELL_CHAR, c.NULL_CELL_WIDTH, c.NULL_CELL_CODE]), this._whitespaceCell = h.CellData.fromCharData([0, c.WHITESPACE_CELL_CHAR, c.WHITESPACE_CELL_WIDTH, c.WHITESPACE_CELL_CODE]), this._isClearing = false, this._memoryCleanupQueue = new r.IdleTaskQueue, this._memoryCleanupPosition = 0, this._cols = this._bufferService.cols, this._rows = this._bufferService.rows, this.lines = new i.CircularList(this._getCorrectBufferLength(this._rows)), this.scrollTop = 0, this.scrollBottom = this._rows - 1, this.setupTabStops();
        }
        getNullCell(e) {
          return e ? (this._nullCell.fg = e.fg, this._nullCell.bg = e.bg, this._nullCell.extended = e.extended) : (this._nullCell.fg = 0, this._nullCell.bg = 0, this._nullCell.extended = new n.ExtendedAttrs), this._nullCell;
        }
        getWhitespaceCell(e) {
          return e ? (this._whitespaceCell.fg = e.fg, this._whitespaceCell.bg = e.bg, this._whitespaceCell.extended = e.extended) : (this._whitespaceCell.fg = 0, this._whitespaceCell.bg = 0, this._whitespaceCell.extended = new n.ExtendedAttrs), this._whitespaceCell;
        }
        getBlankLine(e, t) {
          return new o.BufferLine(this._bufferService.cols, this.getNullCell(e), t);
        }
        get hasScrollback() {
          return this._hasScrollback && this.lines.maxLength > this._rows;
        }
        get isCursorInViewport() {
          const e = this.ybase + this.y - this.ydisp;
          return e >= 0 && e < this._rows;
        }
        _getCorrectBufferLength(e) {
          if (!this._hasScrollback)
            return e;
          const s = e + this._optionsService.rawOptions.scrollback;
          return s > t.MAX_BUFFER_SIZE ? t.MAX_BUFFER_SIZE : s;
        }
        fillViewportRows(e) {
          if (this.lines.length === 0) {
            e === undefined && (e = o.DEFAULT_ATTR_DATA);
            let t = this._rows;
            for (;t--; )
              this.lines.push(this.getBlankLine(e));
          }
        }
        clear() {
          this.ydisp = 0, this.ybase = 0, this.y = 0, this.x = 0, this.lines = new i.CircularList(this._getCorrectBufferLength(this._rows)), this.scrollTop = 0, this.scrollBottom = this._rows - 1, this.setupTabStops();
        }
        resize(e, t) {
          const s = this.getNullCell(o.DEFAULT_ATTR_DATA);
          let i = 0;
          const r = this._getCorrectBufferLength(t);
          if (r > this.lines.maxLength && (this.lines.maxLength = r), this.lines.length > 0) {
            if (this._cols < e)
              for (let t = 0;t < this.lines.length; t++)
                i += +this.lines.get(t).resize(e, s);
            let n = 0;
            if (this._rows < t)
              for (let i = this._rows;i < t; i++)
                this.lines.length < t + this.ybase && (this._optionsService.rawOptions.windowsMode || this._optionsService.rawOptions.windowsPty.backend !== undefined || this._optionsService.rawOptions.windowsPty.buildNumber !== undefined ? this.lines.push(new o.BufferLine(e, s)) : this.ybase > 0 && this.lines.length <= this.ybase + this.y + n + 1 ? (this.ybase--, n++, this.ydisp > 0 && this.ydisp--) : this.lines.push(new o.BufferLine(e, s)));
            else
              for (let e = this._rows;e > t; e--)
                this.lines.length > t + this.ybase && (this.lines.length > this.ybase + this.y + 1 ? this.lines.pop() : (this.ybase++, this.ydisp++));
            if (r < this.lines.maxLength) {
              const e = this.lines.length - r;
              e > 0 && (this.lines.trimStart(e), this.ybase = Math.max(this.ybase - e, 0), this.ydisp = Math.max(this.ydisp - e, 0), this.savedY = Math.max(this.savedY - e, 0)), this.lines.maxLength = r;
            }
            this.x = Math.min(this.x, e - 1), this.y = Math.min(this.y, t - 1), n && (this.y += n), this.savedX = Math.min(this.savedX, e - 1), this.scrollTop = 0;
          }
          if (this.scrollBottom = t - 1, this._isReflowEnabled && (this._reflow(e, t), this._cols > e))
            for (let t = 0;t < this.lines.length; t++)
              i += +this.lines.get(t).resize(e, s);
          this._cols = e, this._rows = t, this._memoryCleanupQueue.clear(), i > 0.1 * this.lines.length && (this._memoryCleanupPosition = 0, this._memoryCleanupQueue.enqueue(() => this._batchedMemoryCleanup()));
        }
        _batchedMemoryCleanup() {
          let e = true;
          this._memoryCleanupPosition >= this.lines.length && (this._memoryCleanupPosition = 0, e = false);
          let t = 0;
          for (;this._memoryCleanupPosition < this.lines.length; )
            if (t += this.lines.get(this._memoryCleanupPosition++).cleanupMemory(), t > 100)
              return true;
          return e;
        }
        get _isReflowEnabled() {
          const e = this._optionsService.rawOptions.windowsPty;
          return e && e.buildNumber ? this._hasScrollback && e.backend === "conpty" && e.buildNumber >= 21376 : this._hasScrollback && !this._optionsService.rawOptions.windowsMode;
        }
        _reflow(e, t) {
          this._cols !== e && (e > this._cols ? this._reflowLarger(e, t) : this._reflowSmaller(e, t));
        }
        _reflowLarger(e, t) {
          const s = this._optionsService.rawOptions.reflowCursorLine, i = (0, a.reflowLargerGetLinesToRemove)(this.lines, this._cols, e, this.ybase + this.y, this.getNullCell(o.DEFAULT_ATTR_DATA), s);
          if (i.length > 0) {
            const s = (0, a.reflowLargerCreateNewLayout)(this.lines, i);
            (0, a.reflowLargerApplyNewLayout)(this.lines, s.layout), this._reflowLargerAdjustViewport(e, t, s.countRemoved);
          }
        }
        _reflowLargerAdjustViewport(e, t, s) {
          const i = this.getNullCell(o.DEFAULT_ATTR_DATA);
          let r = s;
          for (;r-- > 0; )
            this.ybase === 0 ? (this.y > 0 && this.y--, this.lines.length < t && this.lines.push(new o.BufferLine(e, i))) : (this.ydisp === this.ybase && this.ydisp--, this.ybase--);
          this.savedY = Math.max(this.savedY - s, 0);
        }
        _reflowSmaller(e, t) {
          const s = this._optionsService.rawOptions.reflowCursorLine, i = this.getNullCell(o.DEFAULT_ATTR_DATA), r = [];
          let n = 0;
          for (let h = this.lines.length - 1;h >= 0; h--) {
            let c = this.lines.get(h);
            if (!c || !c.isWrapped && c.getTrimmedLength() <= e)
              continue;
            const l = [c];
            for (;c.isWrapped && h > 0; )
              c = this.lines.get(--h), l.unshift(c);
            if (!s) {
              const e = this.ybase + this.y;
              if (e >= h && e < h + l.length)
                continue;
            }
            const u = l[l.length - 1].getTrimmedLength(), d = (0, a.reflowSmallerGetNewLineLengths)(l, this._cols, e), f = d.length - l.length;
            let _;
            _ = this.ybase === 0 && this.y !== this.lines.length - 1 ? Math.max(0, this.y - this.lines.maxLength + f) : Math.max(0, this.lines.length - this.lines.maxLength + f);
            const p = [];
            for (let e = 0;e < f; e++) {
              const e = this.getBlankLine(o.DEFAULT_ATTR_DATA, true);
              p.push(e);
            }
            p.length > 0 && (r.push({ start: h + l.length + n, newLines: p }), n += p.length), l.push(...p);
            let g = d.length - 1, v = d[g];
            v === 0 && (g--, v = d[g]);
            let m = l.length - f - 1, b = u;
            for (;m >= 0; ) {
              const e = Math.min(b, v);
              if (l[g] === undefined)
                break;
              if (l[g].copyCellsFrom(l[m], b - e, v - e, e, true), v -= e, v === 0 && (g--, v = d[g]), b -= e, b === 0) {
                m--;
                const e = Math.max(m, 0);
                b = (0, a.getWrappedLineTrimmedLength)(l, e, this._cols);
              }
            }
            for (let t = 0;t < l.length; t++)
              d[t] < e && l[t].setCell(d[t], i);
            let S = f - _;
            for (;S-- > 0; )
              this.ybase === 0 ? this.y < t - 1 ? (this.y++, this.lines.pop()) : (this.ybase++, this.ydisp++) : this.ybase < Math.min(this.lines.maxLength, this.lines.length + n) - t && (this.ybase === this.ydisp && this.ydisp++, this.ybase++);
            this.savedY = Math.min(this.savedY + f, this.ybase + t - 1);
          }
          if (r.length > 0) {
            const e = [], t = [];
            for (let e = 0;e < this.lines.length; e++)
              t.push(this.lines.get(e));
            const s = this.lines.length;
            let i = s - 1, o = 0, a = r[o];
            this.lines.length = Math.min(this.lines.maxLength, this.lines.length + n);
            let h = 0;
            for (let c = Math.min(this.lines.maxLength - 1, s + n - 1);c >= 0; c--)
              if (a && a.start > i + h) {
                for (let e = a.newLines.length - 1;e >= 0; e--)
                  this.lines.set(c--, a.newLines[e]);
                c++, e.push({ index: i + 1, amount: a.newLines.length }), h += a.newLines.length, a = r[++o];
              } else
                this.lines.set(c, t[i--]);
            let c = 0;
            for (let t = e.length - 1;t >= 0; t--)
              e[t].index += c, this.lines.onInsertEmitter.fire(e[t]), c += e[t].amount;
            const l = Math.max(0, s + n - this.lines.maxLength);
            l > 0 && this.lines.onTrimEmitter.fire(l);
          }
        }
        translateBufferLineToString(e, t, s = 0, i) {
          const r = this.lines.get(e);
          return r ? r.translateToString(t, s, i) : "";
        }
        getWrappedRangeForLine(e) {
          let t = e, s = e;
          for (;t > 0 && this.lines.get(t).isWrapped; )
            t--;
          for (;s + 1 < this.lines.length && this.lines.get(s + 1).isWrapped; )
            s++;
          return { first: t, last: s };
        }
        setupTabStops(e) {
          for (e != null ? this.tabs[e] || (e = this.prevStop(e)) : (this.tabs = {}, e = 0);e < this._cols; e += this._optionsService.rawOptions.tabStopWidth)
            this.tabs[e] = true;
        }
        prevStop(e) {
          for (e == null && (e = this.x);!this.tabs[--e] && e > 0; )
            ;
          return e >= this._cols ? this._cols - 1 : e < 0 ? 0 : e;
        }
        nextStop(e) {
          for (e == null && (e = this.x);!this.tabs[++e] && e < this._cols; )
            ;
          return e >= this._cols ? this._cols - 1 : e < 0 ? 0 : e;
        }
        clearMarkers(e) {
          this._isClearing = true;
          for (let t = 0;t < this.markers.length; t++)
            this.markers[t].line === e && (this.markers[t].dispose(), this.markers.splice(t--, 1));
          this._isClearing = false;
        }
        clearAllMarkers() {
          this._isClearing = true;
          for (let e = 0;e < this.markers.length; e++)
            this.markers[e].dispose();
          this.markers.length = 0, this._isClearing = false;
        }
        addMarker(e) {
          const t = new l.Marker(e);
          return this.markers.push(t), t.register(this.lines.onTrim((e) => {
            t.line -= e, t.line < 0 && t.dispose();
          })), t.register(this.lines.onInsert((e) => {
            t.line >= e.index && (t.line += e.amount);
          })), t.register(this.lines.onDelete((e) => {
            t.line >= e.index && t.line < e.index + e.amount && t.dispose(), t.line > e.index && (t.line -= e.amount);
          })), t.register(t.onDispose(() => this._removeMarker(t))), t;
        }
        _removeMarker(e) {
          this._isClearing || this.markers.splice(this.markers.indexOf(e), 1);
        }
      };
    }, 6107: (e, t, s) => {
      Object.defineProperty(t, "__esModule", { value: true }), t.BufferLine = t.DEFAULT_ATTR_DATA = undefined;
      const i = s(5451), r = s(3055), n = s(8938), o = s(726);
      t.DEFAULT_ATTR_DATA = Object.freeze(new i.AttributeData);
      let a = 0;

      class h {
        constructor(e, t, s = false) {
          this.isWrapped = s, this._combined = {}, this._extendedAttrs = {}, this._data = new Uint32Array(3 * e);
          const i = t || r.CellData.fromCharData([0, n.NULL_CELL_CHAR, n.NULL_CELL_WIDTH, n.NULL_CELL_CODE]);
          for (let t = 0;t < e; ++t)
            this.setCell(t, i);
          this.length = e;
        }
        get(e) {
          const t = this._data[3 * e + 0], s = 2097151 & t;
          return [this._data[3 * e + 1], 2097152 & t ? this._combined[e] : s ? (0, o.stringFromCodePoint)(s) : "", t >> 22, 2097152 & t ? this._combined[e].charCodeAt(this._combined[e].length - 1) : s];
        }
        set(e, t) {
          this._data[3 * e + 1] = t[n.CHAR_DATA_ATTR_INDEX], t[n.CHAR_DATA_CHAR_INDEX].length > 1 ? (this._combined[e] = t[1], this._data[3 * e + 0] = 2097152 | e | t[n.CHAR_DATA_WIDTH_INDEX] << 22) : this._data[3 * e + 0] = t[n.CHAR_DATA_CHAR_INDEX].charCodeAt(0) | t[n.CHAR_DATA_WIDTH_INDEX] << 22;
        }
        getWidth(e) {
          return this._data[3 * e + 0] >> 22;
        }
        hasWidth(e) {
          return 12582912 & this._data[3 * e + 0];
        }
        getFg(e) {
          return this._data[3 * e + 1];
        }
        getBg(e) {
          return this._data[3 * e + 2];
        }
        hasContent(e) {
          return 4194303 & this._data[3 * e + 0];
        }
        getCodePoint(e) {
          const t = this._data[3 * e + 0];
          return 2097152 & t ? this._combined[e].charCodeAt(this._combined[e].length - 1) : 2097151 & t;
        }
        isCombined(e) {
          return 2097152 & this._data[3 * e + 0];
        }
        getString(e) {
          const t = this._data[3 * e + 0];
          return 2097152 & t ? this._combined[e] : 2097151 & t ? (0, o.stringFromCodePoint)(2097151 & t) : "";
        }
        isProtected(e) {
          return 536870912 & this._data[3 * e + 2];
        }
        loadCell(e, t) {
          return a = 3 * e, t.content = this._data[a + 0], t.fg = this._data[a + 1], t.bg = this._data[a + 2], 2097152 & t.content && (t.combinedData = this._combined[e]), 268435456 & t.bg && (t.extended = this._extendedAttrs[e]), t;
        }
        setCell(e, t) {
          2097152 & t.content && (this._combined[e] = t.combinedData), 268435456 & t.bg && (this._extendedAttrs[e] = t.extended), this._data[3 * e + 0] = t.content, this._data[3 * e + 1] = t.fg, this._data[3 * e + 2] = t.bg;
        }
        setCellFromCodepoint(e, t, s, i) {
          268435456 & i.bg && (this._extendedAttrs[e] = i.extended), this._data[3 * e + 0] = t | s << 22, this._data[3 * e + 1] = i.fg, this._data[3 * e + 2] = i.bg;
        }
        addCodepointToCell(e, t, s) {
          let i = this._data[3 * e + 0];
          2097152 & i ? this._combined[e] += (0, o.stringFromCodePoint)(t) : 2097151 & i ? (this._combined[e] = (0, o.stringFromCodePoint)(2097151 & i) + (0, o.stringFromCodePoint)(t), i &= -2097152, i |= 2097152) : i = t | 1 << 22, s && (i &= -12582913, i |= s << 22), this._data[3 * e + 0] = i;
        }
        insertCells(e, t, s) {
          if ((e %= this.length) && this.getWidth(e - 1) === 2 && this.setCellFromCodepoint(e - 1, 0, 1, s), t < this.length - e) {
            const i = new r.CellData;
            for (let s = this.length - e - t - 1;s >= 0; --s)
              this.setCell(e + t + s, this.loadCell(e + s, i));
            for (let i = 0;i < t; ++i)
              this.setCell(e + i, s);
          } else
            for (let t = e;t < this.length; ++t)
              this.setCell(t, s);
          this.getWidth(this.length - 1) === 2 && this.setCellFromCodepoint(this.length - 1, 0, 1, s);
        }
        deleteCells(e, t, s) {
          if (e %= this.length, t < this.length - e) {
            const i = new r.CellData;
            for (let s = 0;s < this.length - e - t; ++s)
              this.setCell(e + s, this.loadCell(e + t + s, i));
            for (let e = this.length - t;e < this.length; ++e)
              this.setCell(e, s);
          } else
            for (let t = e;t < this.length; ++t)
              this.setCell(t, s);
          e && this.getWidth(e - 1) === 2 && this.setCellFromCodepoint(e - 1, 0, 1, s), this.getWidth(e) !== 0 || this.hasContent(e) || this.setCellFromCodepoint(e, 0, 1, s);
        }
        replaceCells(e, t, s, i = false) {
          if (i)
            for (e && this.getWidth(e - 1) === 2 && !this.isProtected(e - 1) && this.setCellFromCodepoint(e - 1, 0, 1, s), t < this.length && this.getWidth(t - 1) === 2 && !this.isProtected(t) && this.setCellFromCodepoint(t, 0, 1, s);e < t && e < this.length; )
              this.isProtected(e) || this.setCell(e, s), e++;
          else
            for (e && this.getWidth(e - 1) === 2 && this.setCellFromCodepoint(e - 1, 0, 1, s), t < this.length && this.getWidth(t - 1) === 2 && this.setCellFromCodepoint(t, 0, 1, s);e < t && e < this.length; )
              this.setCell(e++, s);
        }
        resize(e, t) {
          if (e === this.length)
            return 4 * this._data.length * 2 < this._data.buffer.byteLength;
          const s = 3 * e;
          if (e > this.length) {
            if (this._data.buffer.byteLength >= 4 * s)
              this._data = new Uint32Array(this._data.buffer, 0, s);
            else {
              const e = new Uint32Array(s);
              e.set(this._data), this._data = e;
            }
            for (let s = this.length;s < e; ++s)
              this.setCell(s, t);
          } else {
            this._data = this._data.subarray(0, s);
            const t = Object.keys(this._combined);
            for (let s = 0;s < t.length; s++) {
              const i = parseInt(t[s], 10);
              i >= e && delete this._combined[i];
            }
            const i = Object.keys(this._extendedAttrs);
            for (let t = 0;t < i.length; t++) {
              const s = parseInt(i[t], 10);
              s >= e && delete this._extendedAttrs[s];
            }
          }
          return this.length = e, 4 * s * 2 < this._data.buffer.byteLength;
        }
        cleanupMemory() {
          if (4 * this._data.length * 2 < this._data.buffer.byteLength) {
            const e = new Uint32Array(this._data.length);
            return e.set(this._data), this._data = e, 1;
          }
          return 0;
        }
        fill(e, t = false) {
          if (t)
            for (let t = 0;t < this.length; ++t)
              this.isProtected(t) || this.setCell(t, e);
          else {
            this._combined = {}, this._extendedAttrs = {};
            for (let t = 0;t < this.length; ++t)
              this.setCell(t, e);
          }
        }
        copyFrom(e) {
          this.length !== e.length ? this._data = new Uint32Array(e._data) : this._data.set(e._data), this.length = e.length, this._combined = {};
          for (const t in e._combined)
            this._combined[t] = e._combined[t];
          this._extendedAttrs = {};
          for (const t in e._extendedAttrs)
            this._extendedAttrs[t] = e._extendedAttrs[t];
          this.isWrapped = e.isWrapped;
        }
        clone() {
          const e = new h(0);
          e._data = new Uint32Array(this._data), e.length = this.length;
          for (const t in this._combined)
            e._combined[t] = this._combined[t];
          for (const t in this._extendedAttrs)
            e._extendedAttrs[t] = this._extendedAttrs[t];
          return e.isWrapped = this.isWrapped, e;
        }
        getTrimmedLength() {
          for (let e = this.length - 1;e >= 0; --e)
            if (4194303 & this._data[3 * e + 0])
              return e + (this._data[3 * e + 0] >> 22);
          return 0;
        }
        getNoBgTrimmedLength() {
          for (let e = this.length - 1;e >= 0; --e)
            if (4194303 & this._data[3 * e + 0] || 50331648 & this._data[3 * e + 2])
              return e + (this._data[3 * e + 0] >> 22);
          return 0;
        }
        copyCellsFrom(e, t, s, i, r) {
          const n = e._data;
          if (r)
            for (let r = i - 1;r >= 0; r--) {
              for (let e = 0;e < 3; e++)
                this._data[3 * (s + r) + e] = n[3 * (t + r) + e];
              268435456 & n[3 * (t + r) + 2] && (this._extendedAttrs[s + r] = e._extendedAttrs[t + r]);
            }
          else
            for (let r = 0;r < i; r++) {
              for (let e = 0;e < 3; e++)
                this._data[3 * (s + r) + e] = n[3 * (t + r) + e];
              268435456 & n[3 * (t + r) + 2] && (this._extendedAttrs[s + r] = e._extendedAttrs[t + r]);
            }
          const o = Object.keys(e._combined);
          for (let i = 0;i < o.length; i++) {
            const r = parseInt(o[i], 10);
            r >= t && (this._combined[r - t + s] = e._combined[r]);
          }
        }
        translateToString(e, t, s, i) {
          t = t ?? 0, s = s ?? this.length, e && (s = Math.min(s, this.getTrimmedLength())), i && (i.length = 0);
          let r = "";
          for (;t < s; ) {
            const e = this._data[3 * t + 0], s = 2097151 & e, a = 2097152 & e ? this._combined[t] : s ? (0, o.stringFromCodePoint)(s) : n.WHITESPACE_CELL_CHAR;
            if (r += a, i)
              for (let e = 0;e < a.length; ++e)
                i.push(t);
            t += e >> 22 || 1;
          }
          return i && i.push(t), r;
        }
      }
      t.BufferLine = h;
    }, 732: (e, t) => {
      function s(e, t, s) {
        if (t === e.length - 1)
          return e[t].getTrimmedLength();
        const i = !e[t].hasContent(s - 1) && e[t].getWidth(s - 1) === 1, r = e[t + 1].getWidth(0) === 2;
        return i && r ? s - 1 : s;
      }
      Object.defineProperty(t, "__esModule", { value: true }), t.reflowLargerGetLinesToRemove = function(e, t, i, r, n, o) {
        const a = [];
        for (let h = 0;h < e.length - 1; h++) {
          let c = h, l = e.get(++c);
          if (!l.isWrapped)
            continue;
          const u = [e.get(h)];
          for (;c < e.length && l.isWrapped; )
            u.push(l), l = e.get(++c);
          if (!o && r >= h && r < c) {
            h += u.length - 1;
            continue;
          }
          let d = 0, f = s(u, d, t), _ = 1, p = 0;
          for (;_ < u.length; ) {
            const e = s(u, _, t), r = e - p, o = i - f, a = Math.min(r, o);
            u[d].copyCellsFrom(u[_], p, f, a, false), f += a, f === i && (d++, f = 0), p += a, p === e && (_++, p = 0), f === 0 && d !== 0 && u[d - 1].getWidth(i - 1) === 2 && (u[d].copyCellsFrom(u[d - 1], i - 1, f++, 1, false), u[d - 1].setCell(i - 1, n));
          }
          u[d].replaceCells(f, i, n);
          let g = 0;
          for (let e = u.length - 1;e > 0 && (e > d || u[e].getTrimmedLength() === 0); e--)
            g++;
          g > 0 && (a.push(h + u.length - g), a.push(g)), h += u.length - 1;
        }
        return a;
      }, t.reflowLargerCreateNewLayout = function(e, t) {
        const s = [];
        let i = 0, r = t[i], n = 0;
        for (let o = 0;o < e.length; o++)
          if (r === o) {
            const s = t[++i];
            e.onDeleteEmitter.fire({ index: o - n, amount: s }), o += s - 1, n += s, r = t[++i];
          } else
            s.push(o);
        return { layout: s, countRemoved: n };
      }, t.reflowLargerApplyNewLayout = function(e, t) {
        const s = [];
        for (let i = 0;i < t.length; i++)
          s.push(e.get(t[i]));
        for (let t = 0;t < s.length; t++)
          e.set(t, s[t]);
        e.length = t.length;
      }, t.reflowSmallerGetNewLineLengths = function(e, t, i) {
        const r = [], n = e.map((i, r) => s(e, r, t)).reduce((e, t) => e + t);
        let o = 0, a = 0, h = 0;
        for (;h < n; ) {
          if (n - h < i) {
            r.push(n - h);
            break;
          }
          o += i;
          const c = s(e, a, t);
          o > c && (o -= c, a++);
          const l = e[a].getWidth(o - 1) === 2;
          l && o--;
          const u = l ? i - 1 : i;
          r.push(u), h += u;
        }
        return r;
      }, t.getWrappedLineTrimmedLength = s;
    }, 4097: (e, t, s) => {
      Object.defineProperty(t, "__esModule", { value: true }), t.BufferSet = undefined;
      const i = s(7150), r = s(1073), n = s(802);

      class o extends i.Disposable {
        constructor(e, t) {
          super(), this._optionsService = e, this._bufferService = t, this._onBufferActivate = this._register(new n.Emitter), this.onBufferActivate = this._onBufferActivate.event, this.reset(), this._register(this._optionsService.onSpecificOptionChange("scrollback", () => this.resize(this._bufferService.cols, this._bufferService.rows))), this._register(this._optionsService.onSpecificOptionChange("tabStopWidth", () => this.setupTabStops()));
        }
        reset() {
          this._normal = new r.Buffer(true, this._optionsService, this._bufferService), this._normal.fillViewportRows(), this._alt = new r.Buffer(false, this._optionsService, this._bufferService), this._activeBuffer = this._normal, this._onBufferActivate.fire({ activeBuffer: this._normal, inactiveBuffer: this._alt }), this.setupTabStops();
        }
        get alt() {
          return this._alt;
        }
        get active() {
          return this._activeBuffer;
        }
        get normal() {
          return this._normal;
        }
        activateNormalBuffer() {
          this._activeBuffer !== this._normal && (this._normal.x = this._alt.x, this._normal.y = this._alt.y, this._alt.clearAllMarkers(), this._alt.clear(), this._activeBuffer = this._normal, this._onBufferActivate.fire({ activeBuffer: this._normal, inactiveBuffer: this._alt }));
        }
        activateAltBuffer(e) {
          this._activeBuffer !== this._alt && (this._alt.fillViewportRows(e), this._alt.x = this._normal.x, this._alt.y = this._normal.y, this._activeBuffer = this._alt, this._onBufferActivate.fire({ activeBuffer: this._alt, inactiveBuffer: this._normal }));
        }
        resize(e, t) {
          this._normal.resize(e, t), this._alt.resize(e, t), this.setupTabStops(e);
        }
        setupTabStops(e) {
          this._normal.setupTabStops(e), this._alt.setupTabStops(e);
        }
      }
      t.BufferSet = o;
    }, 3055: (e, t, s) => {
      Object.defineProperty(t, "__esModule", { value: true }), t.CellData = undefined;
      const i = s(726), r = s(8938), n = s(5451);

      class o extends n.AttributeData {
        constructor() {
          super(...arguments), this.content = 0, this.fg = 0, this.bg = 0, this.extended = new n.ExtendedAttrs, this.combinedData = "";
        }
        static fromCharData(e) {
          const t = new o;
          return t.setFromCharData(e), t;
        }
        isCombined() {
          return 2097152 & this.content;
        }
        getWidth() {
          return this.content >> 22;
        }
        getChars() {
          return 2097152 & this.content ? this.combinedData : 2097151 & this.content ? (0, i.stringFromCodePoint)(2097151 & this.content) : "";
        }
        getCode() {
          return this.isCombined() ? this.combinedData.charCodeAt(this.combinedData.length - 1) : 2097151 & this.content;
        }
        setFromCharData(e) {
          this.fg = e[r.CHAR_DATA_ATTR_INDEX], this.bg = 0;
          let t = false;
          if (e[r.CHAR_DATA_CHAR_INDEX].length > 2)
            t = true;
          else if (e[r.CHAR_DATA_CHAR_INDEX].length === 2) {
            const s = e[r.CHAR_DATA_CHAR_INDEX].charCodeAt(0);
            if (55296 <= s && s <= 56319) {
              const i = e[r.CHAR_DATA_CHAR_INDEX].charCodeAt(1);
              56320 <= i && i <= 57343 ? this.content = 1024 * (s - 55296) + i - 56320 + 65536 | e[r.CHAR_DATA_WIDTH_INDEX] << 22 : t = true;
            } else
              t = true;
          } else
            this.content = e[r.CHAR_DATA_CHAR_INDEX].charCodeAt(0) | e[r.CHAR_DATA_WIDTH_INDEX] << 22;
          t && (this.combinedData = e[r.CHAR_DATA_CHAR_INDEX], this.content = 2097152 | e[r.CHAR_DATA_WIDTH_INDEX] << 22);
        }
        getAsCharData() {
          return [this.fg, this.getChars(), this.getWidth(), this.getCode()];
        }
      }
      t.CellData = o;
    }, 8938: (e, t) => {
      Object.defineProperty(t, "__esModule", { value: true }), t.WHITESPACE_CELL_CODE = t.WHITESPACE_CELL_WIDTH = t.WHITESPACE_CELL_CHAR = t.NULL_CELL_CODE = t.NULL_CELL_WIDTH = t.NULL_CELL_CHAR = t.CHAR_DATA_CODE_INDEX = t.CHAR_DATA_WIDTH_INDEX = t.CHAR_DATA_CHAR_INDEX = t.CHAR_DATA_ATTR_INDEX = t.DEFAULT_EXT = t.DEFAULT_ATTR = t.DEFAULT_COLOR = undefined, t.DEFAULT_COLOR = 0, t.DEFAULT_ATTR = t.DEFAULT_COLOR << 9 | 256, t.DEFAULT_EXT = 0, t.CHAR_DATA_ATTR_INDEX = 0, t.CHAR_DATA_CHAR_INDEX = 1, t.CHAR_DATA_WIDTH_INDEX = 2, t.CHAR_DATA_CODE_INDEX = 3, t.NULL_CELL_CHAR = "", t.NULL_CELL_WIDTH = 1, t.NULL_CELL_CODE = 0, t.WHITESPACE_CELL_CHAR = " ", t.WHITESPACE_CELL_WIDTH = 1, t.WHITESPACE_CELL_CODE = 32;
    }, 8158: (e, t, s) => {
      Object.defineProperty(t, "__esModule", { value: true }), t.Marker = undefined;
      const i = s(802), r = s(7150);

      class n {
        get id() {
          return this._id;
        }
        constructor(e) {
          this.line = e, this.isDisposed = false, this._disposables = [], this._id = n._nextId++, this._onDispose = this.register(new i.Emitter), this.onDispose = this._onDispose.event;
        }
        dispose() {
          this.isDisposed || (this.isDisposed = true, this.line = -1, this._onDispose.fire(), (0, r.dispose)(this._disposables), this._disposables.length = 0);
        }
        register(e) {
          return this._disposables.push(e), e;
        }
      }
      t.Marker = n, n._nextId = 1;
    }, 6760: (e, t) => {
      Object.defineProperty(t, "__esModule", { value: true }), t.DEFAULT_CHARSET = t.CHARSETS = undefined, t.CHARSETS = {}, t.DEFAULT_CHARSET = t.CHARSETS.B, t.CHARSETS[0] = { "`": "\u25C6", a: "\u2592", b: "\u2409", c: "\u240C", d: "\u240D", e: "\u240A", f: "\xB0", g: "\xB1", h: "\u2424", i: "\u240B", j: "\u2518", k: "\u2510", l: "\u250C", m: "\u2514", n: "\u253C", o: "\u23BA", p: "\u23BB", q: "\u2500", r: "\u23BC", s: "\u23BD", t: "\u251C", u: "\u2524", v: "\u2534", w: "\u252C", x: "\u2502", y: "\u2264", z: "\u2265", "{": "\u03C0", "|": "\u2260", "}": "\xA3", "~": "\xB7" }, t.CHARSETS.A = { "#": "\xA3" }, t.CHARSETS.B = undefined, t.CHARSETS[4] = { "#": "\xA3", "@": "\xBE", "[": "ij", "\\": "\xBD", "]": "|", "{": "\xA8", "|": "f", "}": "\xBC", "~": "\xB4" }, t.CHARSETS.C = t.CHARSETS[5] = { "[": "\xC4", "\\": "\xD6", "]": "\xC5", "^": "\xDC", "`": "\xE9", "{": "\xE4", "|": "\xF6", "}": "\xE5", "~": "\xFC" }, t.CHARSETS.R = { "#": "\xA3", "@": "\xE0", "[": "\xB0", "\\": "\xE7", "]": "\xA7", "{": "\xE9", "|": "\xF9", "}": "\xE8", "~": "\xA8" }, t.CHARSETS.Q = { "@": "\xE0", "[": "\xE2", "\\": "\xE7", "]": "\xEA", "^": "\xEE", "`": "\xF4", "{": "\xE9", "|": "\xF9", "}": "\xE8", "~": "\xFB" }, t.CHARSETS.K = { "@": "\xA7", "[": "\xC4", "\\": "\xD6", "]": "\xDC", "{": "\xE4", "|": "\xF6", "}": "\xFC", "~": "\xDF" }, t.CHARSETS.Y = { "#": "\xA3", "@": "\xA7", "[": "\xB0", "\\": "\xE7", "]": "\xE9", "`": "\xF9", "{": "\xE0", "|": "\xF2", "}": "\xE8", "~": "\xEC" }, t.CHARSETS.E = t.CHARSETS[6] = { "@": "\xC4", "[": "\xC6", "\\": "\xD8", "]": "\xC5", "^": "\xDC", "`": "\xE4", "{": "\xE6", "|": "\xF8", "}": "\xE5", "~": "\xFC" }, t.CHARSETS.Z = { "#": "\xA3", "@": "\xA7", "[": "\xA1", "\\": "\xD1", "]": "\xBF", "{": "\xB0", "|": "\xF1", "}": "\xE7" }, t.CHARSETS.H = t.CHARSETS[7] = { "@": "\xC9", "[": "\xC4", "\\": "\xD6", "]": "\xC5", "^": "\xDC", "`": "\xE9", "{": "\xE4", "|": "\xF6", "}": "\xE5", "~": "\xFC" }, t.CHARSETS["="] = { "#": "\xF9", "@": "\xE0", "[": "\xE9", "\\": "\xE7", "]": "\xEA", "^": "\xEE", _: "\xE8", "`": "\xF4", "{": "\xE4", "|": "\xF6", "}": "\xFC", "~": "\xFB" };
    }, 3534: (e, t) => {
      var s, i, r;
      Object.defineProperty(t, "__esModule", { value: true }), t.C1_ESCAPED = t.C1 = t.C0 = undefined, function(e) {
        e.NUL = "\x00", e.SOH = "\x01", e.STX = "\x02", e.ETX = "\x03", e.EOT = "\x04", e.ENQ = "\x05", e.ACK = "\x06", e.BEL = "\x07", e.BS = "\b", e.HT = "\t", e.LF = `
`, e.VT = "\v", e.FF = "\f", e.CR = "\r", e.SO = "\x0E", e.SI = "\x0F", e.DLE = "\x10", e.DC1 = "\x11", e.DC2 = "\x12", e.DC3 = "\x13", e.DC4 = "\x14", e.NAK = "\x15", e.SYN = "\x16", e.ETB = "\x17", e.CAN = "\x18", e.EM = "\x19", e.SUB = "\x1A", e.ESC = "\x1B", e.FS = "\x1C", e.GS = "\x1D", e.RS = "\x1E", e.US = "\x1F", e.SP = " ", e.DEL = "\x7F";
      }(s || (t.C0 = s = {})), function(e) {
        e.PAD = "\x80", e.HOP = "\x81", e.BPH = "\x82", e.NBH = "\x83", e.IND = "\x84", e.NEL = "\x85", e.SSA = "\x86", e.ESA = "\x87", e.HTS = "\x88", e.HTJ = "\x89", e.VTS = "\x8A", e.PLD = "\x8B", e.PLU = "\x8C", e.RI = "\x8D", e.SS2 = "\x8E", e.SS3 = "\x8F", e.DCS = "\x90", e.PU1 = "\x91", e.PU2 = "\x92", e.STS = "\x93", e.CCH = "\x94", e.MW = "\x95", e.SPA = "\x96", e.EPA = "\x97", e.SOS = "\x98", e.SGCI = "\x99", e.SCI = "\x9A", e.CSI = "\x9B", e.ST = "\x9C", e.OSC = "\x9D", e.PM = "\x9E", e.APC = "\x9F";
      }(i || (t.C1 = i = {})), function(e) {
        e.ST = `${s.ESC}\\`;
      }(r || (t.C1_ESCAPED = r = {}));
    }, 726: (e, t) => {
      Object.defineProperty(t, "__esModule", { value: true }), t.Utf8ToUtf32 = t.StringToUtf32 = undefined, t.stringFromCodePoint = function(e) {
        return e > 65535 ? (e -= 65536, String.fromCharCode(55296 + (e >> 10)) + String.fromCharCode(e % 1024 + 56320)) : String.fromCharCode(e);
      }, t.utf32ToString = function(e, t = 0, s = e.length) {
        let i = "";
        for (let r = t;r < s; ++r) {
          let t = e[r];
          t > 65535 ? (t -= 65536, i += String.fromCharCode(55296 + (t >> 10)) + String.fromCharCode(t % 1024 + 56320)) : i += String.fromCharCode(t);
        }
        return i;
      }, t.StringToUtf32 = class {
        constructor() {
          this._interim = 0;
        }
        clear() {
          this._interim = 0;
        }
        decode(e, t) {
          const s = e.length;
          if (!s)
            return 0;
          let i = 0, r = 0;
          if (this._interim) {
            const s = e.charCodeAt(r++);
            56320 <= s && s <= 57343 ? t[i++] = 1024 * (this._interim - 55296) + s - 56320 + 65536 : (t[i++] = this._interim, t[i++] = s), this._interim = 0;
          }
          for (let n = r;n < s; ++n) {
            const r = e.charCodeAt(n);
            if (55296 <= r && r <= 56319) {
              if (++n >= s)
                return this._interim = r, i;
              const o = e.charCodeAt(n);
              56320 <= o && o <= 57343 ? t[i++] = 1024 * (r - 55296) + o - 56320 + 65536 : (t[i++] = r, t[i++] = o);
            } else
              r !== 65279 && (t[i++] = r);
          }
          return i;
        }
      }, t.Utf8ToUtf32 = class {
        constructor() {
          this.interim = new Uint8Array(3);
        }
        clear() {
          this.interim.fill(0);
        }
        decode(e, t) {
          const s = e.length;
          if (!s)
            return 0;
          let i, r, n, o, a = 0, h = 0, c = 0;
          if (this.interim[0]) {
            let i = false, r = this.interim[0];
            r &= (224 & r) == 192 ? 31 : (240 & r) == 224 ? 15 : 7;
            let n, o = 0;
            for (;(n = 63 & this.interim[++o]) && o < 4; )
              r <<= 6, r |= n;
            const h = (224 & this.interim[0]) == 192 ? 2 : (240 & this.interim[0]) == 224 ? 3 : 4, l = h - o;
            for (;c < l; ) {
              if (c >= s)
                return 0;
              if (n = e[c++], (192 & n) != 128) {
                c--, i = true;
                break;
              }
              this.interim[o++] = n, r <<= 6, r |= 63 & n;
            }
            i || (h === 2 ? r < 128 ? c-- : t[a++] = r : h === 3 ? r < 2048 || r >= 55296 && r <= 57343 || r === 65279 || (t[a++] = r) : r < 65536 || r > 1114111 || (t[a++] = r)), this.interim.fill(0);
          }
          const l = s - 4;
          let u = c;
          for (;u < s; ) {
            for (;!(!(u < l) || 128 & (i = e[u]) || 128 & (r = e[u + 1]) || 128 & (n = e[u + 2]) || 128 & (o = e[u + 3])); )
              t[a++] = i, t[a++] = r, t[a++] = n, t[a++] = o, u += 4;
            if (i = e[u++], i < 128)
              t[a++] = i;
            else if ((224 & i) == 192) {
              if (u >= s)
                return this.interim[0] = i, a;
              if (r = e[u++], (192 & r) != 128) {
                u--;
                continue;
              }
              if (h = (31 & i) << 6 | 63 & r, h < 128) {
                u--;
                continue;
              }
              t[a++] = h;
            } else if ((240 & i) == 224) {
              if (u >= s)
                return this.interim[0] = i, a;
              if (r = e[u++], (192 & r) != 128) {
                u--;
                continue;
              }
              if (u >= s)
                return this.interim[0] = i, this.interim[1] = r, a;
              if (n = e[u++], (192 & n) != 128) {
                u--;
                continue;
              }
              if (h = (15 & i) << 12 | (63 & r) << 6 | 63 & n, h < 2048 || h >= 55296 && h <= 57343 || h === 65279)
                continue;
              t[a++] = h;
            } else if ((248 & i) == 240) {
              if (u >= s)
                return this.interim[0] = i, a;
              if (r = e[u++], (192 & r) != 128) {
                u--;
                continue;
              }
              if (u >= s)
                return this.interim[0] = i, this.interim[1] = r, a;
              if (n = e[u++], (192 & n) != 128) {
                u--;
                continue;
              }
              if (u >= s)
                return this.interim[0] = i, this.interim[1] = r, this.interim[2] = n, a;
              if (o = e[u++], (192 & o) != 128) {
                u--;
                continue;
              }
              if (h = (7 & i) << 18 | (63 & r) << 12 | (63 & n) << 6 | 63 & o, h < 65536 || h > 1114111)
                continue;
              t[a++] = h;
            }
          }
          return a;
        }
      };
    }, 7428: (e, t, s) => {
      Object.defineProperty(t, "__esModule", { value: true }), t.UnicodeV6 = undefined;
      const i = s(6415), r = [[768, 879], [1155, 1158], [1160, 1161], [1425, 1469], [1471, 1471], [1473, 1474], [1476, 1477], [1479, 1479], [1536, 1539], [1552, 1557], [1611, 1630], [1648, 1648], [1750, 1764], [1767, 1768], [1770, 1773], [1807, 1807], [1809, 1809], [1840, 1866], [1958, 1968], [2027, 2035], [2305, 2306], [2364, 2364], [2369, 2376], [2381, 2381], [2385, 2388], [2402, 2403], [2433, 2433], [2492, 2492], [2497, 2500], [2509, 2509], [2530, 2531], [2561, 2562], [2620, 2620], [2625, 2626], [2631, 2632], [2635, 2637], [2672, 2673], [2689, 2690], [2748, 2748], [2753, 2757], [2759, 2760], [2765, 2765], [2786, 2787], [2817, 2817], [2876, 2876], [2879, 2879], [2881, 2883], [2893, 2893], [2902, 2902], [2946, 2946], [3008, 3008], [3021, 3021], [3134, 3136], [3142, 3144], [3146, 3149], [3157, 3158], [3260, 3260], [3263, 3263], [3270, 3270], [3276, 3277], [3298, 3299], [3393, 3395], [3405, 3405], [3530, 3530], [3538, 3540], [3542, 3542], [3633, 3633], [3636, 3642], [3655, 3662], [3761, 3761], [3764, 3769], [3771, 3772], [3784, 3789], [3864, 3865], [3893, 3893], [3895, 3895], [3897, 3897], [3953, 3966], [3968, 3972], [3974, 3975], [3984, 3991], [3993, 4028], [4038, 4038], [4141, 4144], [4146, 4146], [4150, 4151], [4153, 4153], [4184, 4185], [4448, 4607], [4959, 4959], [5906, 5908], [5938, 5940], [5970, 5971], [6002, 6003], [6068, 6069], [6071, 6077], [6086, 6086], [6089, 6099], [6109, 6109], [6155, 6157], [6313, 6313], [6432, 6434], [6439, 6440], [6450, 6450], [6457, 6459], [6679, 6680], [6912, 6915], [6964, 6964], [6966, 6970], [6972, 6972], [6978, 6978], [7019, 7027], [7616, 7626], [7678, 7679], [8203, 8207], [8234, 8238], [8288, 8291], [8298, 8303], [8400, 8431], [12330, 12335], [12441, 12442], [43014, 43014], [43019, 43019], [43045, 43046], [64286, 64286], [65024, 65039], [65056, 65059], [65279, 65279], [65529, 65531]], n = [[68097, 68099], [68101, 68102], [68108, 68111], [68152, 68154], [68159, 68159], [119143, 119145], [119155, 119170], [119173, 119179], [119210, 119213], [119362, 119364], [917505, 917505], [917536, 917631], [917760, 917999]];
      let o;
      t.UnicodeV6 = class {
        constructor() {
          if (this.version = "6", !o) {
            o = new Uint8Array(65536), o.fill(1), o[0] = 0, o.fill(0, 1, 32), o.fill(0, 127, 160), o.fill(2, 4352, 4448), o[9001] = 2, o[9002] = 2, o.fill(2, 11904, 42192), o[12351] = 1, o.fill(2, 44032, 55204), o.fill(2, 63744, 64256), o.fill(2, 65040, 65050), o.fill(2, 65072, 65136), o.fill(2, 65280, 65377), o.fill(2, 65504, 65511);
            for (let e = 0;e < r.length; ++e)
              o.fill(0, r[e][0], r[e][1] + 1);
          }
        }
        wcwidth(e) {
          return e < 32 ? 0 : e < 127 ? 1 : e < 65536 ? o[e] : function(e, t) {
            let s, i = 0, r = t.length - 1;
            if (e < t[0][0] || e > t[r][1])
              return false;
            for (;r >= i; )
              if (s = i + r >> 1, e > t[s][1])
                i = s + 1;
              else {
                if (!(e < t[s][0]))
                  return true;
                r = s - 1;
              }
            return false;
          }(e, n) ? 0 : e >= 131072 && e <= 196605 || e >= 196608 && e <= 262141 ? 2 : 1;
        }
        charProperties(e, t) {
          let s = this.wcwidth(e), r = s === 0 && t !== 0;
          if (r) {
            const e = i.UnicodeService.extractWidth(t);
            e === 0 ? r = false : e > s && (s = e);
          }
          return i.UnicodeService.createPropertyValue(0, s, r);
        }
      };
    }, 3562: (e, t, s) => {
      Object.defineProperty(t, "__esModule", { value: true }), t.WriteBuffer = undefined;
      const i = s(7150), r = s(802);

      class n extends i.Disposable {
        constructor(e) {
          super(), this._action = e, this._writeBuffer = [], this._callbacks = [], this._pendingData = 0, this._bufferOffset = 0, this._isSyncWriting = false, this._syncCalls = 0, this._didUserInput = false, this._onWriteParsed = this._register(new r.Emitter), this.onWriteParsed = this._onWriteParsed.event;
        }
        handleUserInput() {
          this._didUserInput = true;
        }
        writeSync(e, t) {
          if (t !== undefined && this._syncCalls > t)
            return void (this._syncCalls = 0);
          if (this._pendingData += e.length, this._writeBuffer.push(e), this._callbacks.push(undefined), this._syncCalls++, this._isSyncWriting)
            return;
          let s;
          for (this._isSyncWriting = true;s = this._writeBuffer.shift(); ) {
            this._action(s);
            const e = this._callbacks.shift();
            e && e();
          }
          this._pendingData = 0, this._bufferOffset = 2147483647, this._isSyncWriting = false, this._syncCalls = 0;
        }
        write(e, t) {
          if (this._pendingData > 50000000)
            throw new Error("write data discarded, use flow control to avoid losing data");
          if (!this._writeBuffer.length) {
            if (this._bufferOffset = 0, this._didUserInput)
              return this._didUserInput = false, this._pendingData += e.length, this._writeBuffer.push(e), this._callbacks.push(t), void this._innerWrite();
            setTimeout(() => this._innerWrite());
          }
          this._pendingData += e.length, this._writeBuffer.push(e), this._callbacks.push(t);
        }
        _innerWrite(e = 0, t = true) {
          const s = e || performance.now();
          for (;this._writeBuffer.length > this._bufferOffset; ) {
            const e = this._writeBuffer[this._bufferOffset], i = this._action(e, t);
            if (i) {
              const e = (e) => performance.now() - s >= 12 ? setTimeout(() => this._innerWrite(0, e)) : this._innerWrite(s, e);
              return void i.catch((e) => (queueMicrotask(() => {
                throw e;
              }), Promise.resolve(false))).then(e);
            }
            const r = this._callbacks[this._bufferOffset];
            if (r && r(), this._bufferOffset++, this._pendingData -= e.length, performance.now() - s >= 12)
              break;
          }
          this._writeBuffer.length > this._bufferOffset ? (this._bufferOffset > 50 && (this._writeBuffer = this._writeBuffer.slice(this._bufferOffset), this._callbacks = this._callbacks.slice(this._bufferOffset), this._bufferOffset = 0), setTimeout(() => this._innerWrite())) : (this._writeBuffer.length = 0, this._callbacks.length = 0, this._pendingData = 0, this._bufferOffset = 0), this._onWriteParsed.fire();
        }
      }
      t.WriteBuffer = n;
    }, 8693: (e, t) => {
      Object.defineProperty(t, "__esModule", { value: true }), t.parseColor = function(e) {
        if (!e)
          return;
        let t = e.toLowerCase();
        if (t.indexOf("rgb:") === 0) {
          t = t.slice(4);
          const e = s.exec(t);
          if (e) {
            const t = e[1] ? 15 : e[4] ? 255 : e[7] ? 4095 : 65535;
            return [Math.round(parseInt(e[1] || e[4] || e[7] || e[10], 16) / t * 255), Math.round(parseInt(e[2] || e[5] || e[8] || e[11], 16) / t * 255), Math.round(parseInt(e[3] || e[6] || e[9] || e[12], 16) / t * 255)];
          }
        } else if (t.indexOf("#") === 0 && (t = t.slice(1), i.exec(t) && [3, 6, 9, 12].includes(t.length))) {
          const e = t.length / 3, s = [0, 0, 0];
          for (let i = 0;i < 3; ++i) {
            const r = parseInt(t.slice(e * i, e * i + e), 16);
            s[i] = e === 1 ? r << 4 : e === 2 ? r : e === 3 ? r >> 4 : r >> 8;
          }
          return s;
        }
      }, t.toRgbString = function(e, t = 16) {
        const [s, i, n] = e;
        return `rgb:${r(s, t)}/${r(i, t)}/${r(n, t)}`;
      };
      const s = /^([\da-f])\/([\da-f])\/([\da-f])$|^([\da-f]{2})\/([\da-f]{2})\/([\da-f]{2})$|^([\da-f]{3})\/([\da-f]{3})\/([\da-f]{3})$|^([\da-f]{4})\/([\da-f]{4})\/([\da-f]{4})$/, i = /^[\da-f]+$/;
      function r(e, t) {
        const s = e.toString(16), i = s.length < 2 ? "0" + s : s;
        switch (t) {
          case 4:
            return s[0];
          case 8:
            return i;
          case 12:
            return (i + i).slice(0, 3);
          default:
            return i + i;
        }
      }
    }, 1263: (e, t) => {
      Object.defineProperty(t, "__esModule", { value: true }), t.PAYLOAD_LIMIT = undefined, t.PAYLOAD_LIMIT = 1e7;
    }, 9823: (e, t, s) => {
      Object.defineProperty(t, "__esModule", { value: true }), t.DcsHandler = t.DcsParser = undefined;
      const i = s(726), r = s(7262), n = s(1263), o = [];
      t.DcsParser = class {
        constructor() {
          this._handlers = Object.create(null), this._active = o, this._ident = 0, this._handlerFb = () => {}, this._stack = { paused: false, loopPosition: 0, fallThrough: false };
        }
        dispose() {
          this._handlers = Object.create(null), this._handlerFb = () => {}, this._active = o;
        }
        registerHandler(e, t) {
          this._handlers[e] === undefined && (this._handlers[e] = []);
          const s = this._handlers[e];
          return s.push(t), { dispose: () => {
            const e = s.indexOf(t);
            e !== -1 && s.splice(e, 1);
          } };
        }
        clearHandler(e) {
          this._handlers[e] && delete this._handlers[e];
        }
        setHandlerFallback(e) {
          this._handlerFb = e;
        }
        reset() {
          if (this._active.length)
            for (let e = this._stack.paused ? this._stack.loopPosition - 1 : this._active.length - 1;e >= 0; --e)
              this._active[e].unhook(false);
          this._stack.paused = false, this._active = o, this._ident = 0;
        }
        hook(e, t) {
          if (this.reset(), this._ident = e, this._active = this._handlers[e] || o, this._active.length)
            for (let e = this._active.length - 1;e >= 0; e--)
              this._active[e].hook(t);
          else
            this._handlerFb(this._ident, "HOOK", t);
        }
        put(e, t, s) {
          if (this._active.length)
            for (let i = this._active.length - 1;i >= 0; i--)
              this._active[i].put(e, t, s);
          else
            this._handlerFb(this._ident, "PUT", (0, i.utf32ToString)(e, t, s));
        }
        unhook(e, t = true) {
          if (this._active.length) {
            let s = false, i = this._active.length - 1, r = false;
            if (this._stack.paused && (i = this._stack.loopPosition - 1, s = t, r = this._stack.fallThrough, this._stack.paused = false), !r && s === false) {
              for (;i >= 0 && (s = this._active[i].unhook(e), s !== true); i--)
                if (s instanceof Promise)
                  return this._stack.paused = true, this._stack.loopPosition = i, this._stack.fallThrough = false, s;
              i--;
            }
            for (;i >= 0; i--)
              if (s = this._active[i].unhook(false), s instanceof Promise)
                return this._stack.paused = true, this._stack.loopPosition = i, this._stack.fallThrough = true, s;
          } else
            this._handlerFb(this._ident, "UNHOOK", e);
          this._active = o, this._ident = 0;
        }
      };
      const a = new r.Params;
      a.addParam(0), t.DcsHandler = class {
        constructor(e) {
          this._handler = e, this._data = "", this._params = a, this._hitLimit = false;
        }
        hook(e) {
          this._params = e.length > 1 || e.params[0] ? e.clone() : a, this._data = "", this._hitLimit = false;
        }
        put(e, t, s) {
          this._hitLimit || (this._data += (0, i.utf32ToString)(e, t, s), this._data.length > n.PAYLOAD_LIMIT && (this._data = "", this._hitLimit = true));
        }
        unhook(e) {
          let t = false;
          if (this._hitLimit)
            t = false;
          else if (e && (t = this._handler(this._data, this._params), t instanceof Promise))
            return t.then((e) => (this._params = a, this._data = "", this._hitLimit = false, e));
          return this._params = a, this._data = "", this._hitLimit = false, t;
        }
      };
    }, 6717: (e, t, s) => {
      Object.defineProperty(t, "__esModule", { value: true }), t.EscapeSequenceParser = t.VT500_TRANSITION_TABLE = t.TransitionTable = undefined;
      const i = s(7150), r = s(7262), n = s(1346), o = s(9823);

      class a {
        constructor(e) {
          this.table = new Uint8Array(e);
        }
        setDefault(e, t) {
          this.table.fill(e << 4 | t);
        }
        add(e, t, s, i) {
          this.table[t << 8 | e] = s << 4 | i;
        }
        addMany(e, t, s, i) {
          for (let r = 0;r < e.length; r++)
            this.table[t << 8 | e[r]] = s << 4 | i;
        }
      }
      t.TransitionTable = a;
      const h = 160;
      t.VT500_TRANSITION_TABLE = function() {
        const e = new a(4095), t = Array.apply(null, Array(256)).map((e, t) => t), s = (e, s) => t.slice(e, s), i = s(32, 127), r = s(0, 24);
        r.push(25), r.push.apply(r, s(28, 32));
        const n = s(0, 14);
        let o;
        for (o in e.setDefault(1, 0), e.addMany(i, 0, 2, 0), n)
          e.addMany([24, 26, 153, 154], o, 3, 0), e.addMany(s(128, 144), o, 3, 0), e.addMany(s(144, 152), o, 3, 0), e.add(156, o, 0, 0), e.add(27, o, 11, 1), e.add(157, o, 4, 8), e.addMany([152, 158, 159], o, 0, 7), e.add(155, o, 11, 3), e.add(144, o, 11, 9);
        return e.addMany(r, 0, 3, 0), e.addMany(r, 1, 3, 1), e.add(127, 1, 0, 1), e.addMany(r, 8, 0, 8), e.addMany(r, 3, 3, 3), e.add(127, 3, 0, 3), e.addMany(r, 4, 3, 4), e.add(127, 4, 0, 4), e.addMany(r, 6, 3, 6), e.addMany(r, 5, 3, 5), e.add(127, 5, 0, 5), e.addMany(r, 2, 3, 2), e.add(127, 2, 0, 2), e.add(93, 1, 4, 8), e.addMany(i, 8, 5, 8), e.add(127, 8, 5, 8), e.addMany([156, 27, 24, 26, 7], 8, 6, 0), e.addMany(s(28, 32), 8, 0, 8), e.addMany([88, 94, 95], 1, 0, 7), e.addMany(i, 7, 0, 7), e.addMany(r, 7, 0, 7), e.add(156, 7, 0, 0), e.add(127, 7, 0, 7), e.add(91, 1, 11, 3), e.addMany(s(64, 127), 3, 7, 0), e.addMany(s(48, 60), 3, 8, 4), e.addMany([60, 61, 62, 63], 3, 9, 4), e.addMany(s(48, 60), 4, 8, 4), e.addMany(s(64, 127), 4, 7, 0), e.addMany([60, 61, 62, 63], 4, 0, 6), e.addMany(s(32, 64), 6, 0, 6), e.add(127, 6, 0, 6), e.addMany(s(64, 127), 6, 0, 0), e.addMany(s(32, 48), 3, 9, 5), e.addMany(s(32, 48), 5, 9, 5), e.addMany(s(48, 64), 5, 0, 6), e.addMany(s(64, 127), 5, 7, 0), e.addMany(s(32, 48), 4, 9, 5), e.addMany(s(32, 48), 1, 9, 2), e.addMany(s(32, 48), 2, 9, 2), e.addMany(s(48, 127), 2, 10, 0), e.addMany(s(48, 80), 1, 10, 0), e.addMany(s(81, 88), 1, 10, 0), e.addMany([89, 90, 92], 1, 10, 0), e.addMany(s(96, 127), 1, 10, 0), e.add(80, 1, 11, 9), e.addMany(r, 9, 0, 9), e.add(127, 9, 0, 9), e.addMany(s(28, 32), 9, 0, 9), e.addMany(s(32, 48), 9, 9, 12), e.addMany(s(48, 60), 9, 8, 10), e.addMany([60, 61, 62, 63], 9, 9, 10), e.addMany(r, 11, 0, 11), e.addMany(s(32, 128), 11, 0, 11), e.addMany(s(28, 32), 11, 0, 11), e.addMany(r, 10, 0, 10), e.add(127, 10, 0, 10), e.addMany(s(28, 32), 10, 0, 10), e.addMany(s(48, 60), 10, 8, 10), e.addMany([60, 61, 62, 63], 10, 0, 11), e.addMany(s(32, 48), 10, 9, 12), e.addMany(r, 12, 0, 12), e.add(127, 12, 0, 12), e.addMany(s(28, 32), 12, 0, 12), e.addMany(s(32, 48), 12, 9, 12), e.addMany(s(48, 64), 12, 0, 11), e.addMany(s(64, 127), 12, 12, 13), e.addMany(s(64, 127), 10, 12, 13), e.addMany(s(64, 127), 9, 12, 13), e.addMany(r, 13, 13, 13), e.addMany(i, 13, 13, 13), e.add(127, 13, 0, 13), e.addMany([27, 156, 24, 26], 13, 14, 0), e.add(h, 0, 2, 0), e.add(h, 8, 5, 8), e.add(h, 6, 0, 6), e.add(h, 11, 0, 11), e.add(h, 13, 13, 13), e;
      }();

      class c extends i.Disposable {
        constructor(e = t.VT500_TRANSITION_TABLE) {
          super(), this._transitions = e, this._parseStack = { state: 0, handlers: [], handlerPos: 0, transition: 0, chunkPos: 0 }, this.initialState = 0, this.currentState = this.initialState, this._params = new r.Params, this._params.addParam(0), this._collect = 0, this.precedingJoinState = 0, this._printHandlerFb = (e, t, s) => {}, this._executeHandlerFb = (e) => {}, this._csiHandlerFb = (e, t) => {}, this._escHandlerFb = (e) => {}, this._errorHandlerFb = (e) => e, this._printHandler = this._printHandlerFb, this._executeHandlers = Object.create(null), this._csiHandlers = Object.create(null), this._escHandlers = Object.create(null), this._register((0, i.toDisposable)(() => {
            this._csiHandlers = Object.create(null), this._executeHandlers = Object.create(null), this._escHandlers = Object.create(null);
          })), this._oscParser = this._register(new n.OscParser), this._dcsParser = this._register(new o.DcsParser), this._errorHandler = this._errorHandlerFb, this.registerEscHandler({ final: "\\" }, () => true);
        }
        _identifier(e, t = [64, 126]) {
          let s = 0;
          if (e.prefix) {
            if (e.prefix.length > 1)
              throw new Error("only one byte as prefix supported");
            if (s = e.prefix.charCodeAt(0), s && 60 > s || s > 63)
              throw new Error("prefix must be in range 0x3c .. 0x3f");
          }
          if (e.intermediates) {
            if (e.intermediates.length > 2)
              throw new Error("only two bytes as intermediates are supported");
            for (let t = 0;t < e.intermediates.length; ++t) {
              const i = e.intermediates.charCodeAt(t);
              if (32 > i || i > 47)
                throw new Error("intermediate must be in range 0x20 .. 0x2f");
              s <<= 8, s |= i;
            }
          }
          if (e.final.length !== 1)
            throw new Error("final must be a single byte");
          const i = e.final.charCodeAt(0);
          if (t[0] > i || i > t[1])
            throw new Error(`final must be in range ${t[0]} .. ${t[1]}`);
          return s <<= 8, s |= i, s;
        }
        identToString(e) {
          const t = [];
          for (;e; )
            t.push(String.fromCharCode(255 & e)), e >>= 8;
          return t.reverse().join("");
        }
        setPrintHandler(e) {
          this._printHandler = e;
        }
        clearPrintHandler() {
          this._printHandler = this._printHandlerFb;
        }
        registerEscHandler(e, t) {
          const s = this._identifier(e, [48, 126]);
          this._escHandlers[s] === undefined && (this._escHandlers[s] = []);
          const i = this._escHandlers[s];
          return i.push(t), { dispose: () => {
            const e = i.indexOf(t);
            e !== -1 && i.splice(e, 1);
          } };
        }
        clearEscHandler(e) {
          this._escHandlers[this._identifier(e, [48, 126])] && delete this._escHandlers[this._identifier(e, [48, 126])];
        }
        setEscHandlerFallback(e) {
          this._escHandlerFb = e;
        }
        setExecuteHandler(e, t) {
          this._executeHandlers[e.charCodeAt(0)] = t;
        }
        clearExecuteHandler(e) {
          this._executeHandlers[e.charCodeAt(0)] && delete this._executeHandlers[e.charCodeAt(0)];
        }
        setExecuteHandlerFallback(e) {
          this._executeHandlerFb = e;
        }
        registerCsiHandler(e, t) {
          const s = this._identifier(e);
          this._csiHandlers[s] === undefined && (this._csiHandlers[s] = []);
          const i = this._csiHandlers[s];
          return i.push(t), { dispose: () => {
            const e = i.indexOf(t);
            e !== -1 && i.splice(e, 1);
          } };
        }
        clearCsiHandler(e) {
          this._csiHandlers[this._identifier(e)] && delete this._csiHandlers[this._identifier(e)];
        }
        setCsiHandlerFallback(e) {
          this._csiHandlerFb = e;
        }
        registerDcsHandler(e, t) {
          return this._dcsParser.registerHandler(this._identifier(e), t);
        }
        clearDcsHandler(e) {
          this._dcsParser.clearHandler(this._identifier(e));
        }
        setDcsHandlerFallback(e) {
          this._dcsParser.setHandlerFallback(e);
        }
        registerOscHandler(e, t) {
          return this._oscParser.registerHandler(e, t);
        }
        clearOscHandler(e) {
          this._oscParser.clearHandler(e);
        }
        setOscHandlerFallback(e) {
          this._oscParser.setHandlerFallback(e);
        }
        setErrorHandler(e) {
          this._errorHandler = e;
        }
        clearErrorHandler() {
          this._errorHandler = this._errorHandlerFb;
        }
        reset() {
          this.currentState = this.initialState, this._oscParser.reset(), this._dcsParser.reset(), this._params.reset(), this._params.addParam(0), this._collect = 0, this.precedingJoinState = 0, this._parseStack.state !== 0 && (this._parseStack.state = 2, this._parseStack.handlers = []);
        }
        _preserveStack(e, t, s, i, r) {
          this._parseStack.state = e, this._parseStack.handlers = t, this._parseStack.handlerPos = s, this._parseStack.transition = i, this._parseStack.chunkPos = r;
        }
        parse(e, t, s) {
          let i, r = 0, n = 0, o = 0;
          if (this._parseStack.state)
            if (this._parseStack.state === 2)
              this._parseStack.state = 0, o = this._parseStack.chunkPos + 1;
            else {
              if (s === undefined || this._parseStack.state === 1)
                throw this._parseStack.state = 1, new Error("improper continuation due to previous async handler, giving up parsing");
              const t = this._parseStack.handlers;
              let n = this._parseStack.handlerPos - 1;
              switch (this._parseStack.state) {
                case 3:
                  if (s === false && n > -1) {
                    for (;n >= 0 && (i = t[n](this._params), i !== true); n--)
                      if (i instanceof Promise)
                        return this._parseStack.handlerPos = n, i;
                  }
                  this._parseStack.handlers = [];
                  break;
                case 4:
                  if (s === false && n > -1) {
                    for (;n >= 0 && (i = t[n](), i !== true); n--)
                      if (i instanceof Promise)
                        return this._parseStack.handlerPos = n, i;
                  }
                  this._parseStack.handlers = [];
                  break;
                case 6:
                  if (r = e[this._parseStack.chunkPos], i = this._dcsParser.unhook(r !== 24 && r !== 26, s), i)
                    return i;
                  r === 27 && (this._parseStack.transition |= 1), this._params.reset(), this._params.addParam(0), this._collect = 0;
                  break;
                case 5:
                  if (r = e[this._parseStack.chunkPos], i = this._oscParser.end(r !== 24 && r !== 26, s), i)
                    return i;
                  r === 27 && (this._parseStack.transition |= 1), this._params.reset(), this._params.addParam(0), this._collect = 0;
              }
              this._parseStack.state = 0, o = this._parseStack.chunkPos + 1, this.precedingJoinState = 0, this.currentState = 15 & this._parseStack.transition;
            }
          for (let s = o;s < t; ++s) {
            switch (r = e[s], n = this._transitions.table[this.currentState << 8 | (r < 160 ? r : h)], n >> 4) {
              case 2:
                for (let i = s + 1;; ++i) {
                  if (i >= t || (r = e[i]) < 32 || r > 126 && r < h) {
                    this._printHandler(e, s, i), s = i - 1;
                    break;
                  }
                  if (++i >= t || (r = e[i]) < 32 || r > 126 && r < h) {
                    this._printHandler(e, s, i), s = i - 1;
                    break;
                  }
                  if (++i >= t || (r = e[i]) < 32 || r > 126 && r < h) {
                    this._printHandler(e, s, i), s = i - 1;
                    break;
                  }
                  if (++i >= t || (r = e[i]) < 32 || r > 126 && r < h) {
                    this._printHandler(e, s, i), s = i - 1;
                    break;
                  }
                }
                break;
              case 3:
                this._executeHandlers[r] ? this._executeHandlers[r]() : this._executeHandlerFb(r), this.precedingJoinState = 0;
                break;
              case 0:
                break;
              case 1:
                if (this._errorHandler({ position: s, code: r, currentState: this.currentState, collect: this._collect, params: this._params, abort: false }).abort)
                  return;
                break;
              case 7:
                const o = this._csiHandlers[this._collect << 8 | r];
                let a = o ? o.length - 1 : -1;
                for (;a >= 0 && (i = o[a](this._params), i !== true); a--)
                  if (i instanceof Promise)
                    return this._preserveStack(3, o, a, n, s), i;
                a < 0 && this._csiHandlerFb(this._collect << 8 | r, this._params), this.precedingJoinState = 0;
                break;
              case 8:
                do {
                  switch (r) {
                    case 59:
                      this._params.addParam(0);
                      break;
                    case 58:
                      this._params.addSubParam(-1);
                      break;
                    default:
                      this._params.addDigit(r - 48);
                  }
                } while (++s < t && (r = e[s]) > 47 && r < 60);
                s--;
                break;
              case 9:
                this._collect <<= 8, this._collect |= r;
                break;
              case 10:
                const c = this._escHandlers[this._collect << 8 | r];
                let l = c ? c.length - 1 : -1;
                for (;l >= 0 && (i = c[l](), i !== true); l--)
                  if (i instanceof Promise)
                    return this._preserveStack(4, c, l, n, s), i;
                l < 0 && this._escHandlerFb(this._collect << 8 | r), this.precedingJoinState = 0;
                break;
              case 11:
                this._params.reset(), this._params.addParam(0), this._collect = 0;
                break;
              case 12:
                this._dcsParser.hook(this._collect << 8 | r, this._params);
                break;
              case 13:
                for (let i = s + 1;; ++i)
                  if (i >= t || (r = e[i]) === 24 || r === 26 || r === 27 || r > 127 && r < h) {
                    this._dcsParser.put(e, s, i), s = i - 1;
                    break;
                  }
                break;
              case 14:
                if (i = this._dcsParser.unhook(r !== 24 && r !== 26), i)
                  return this._preserveStack(6, [], 0, n, s), i;
                r === 27 && (n |= 1), this._params.reset(), this._params.addParam(0), this._collect = 0, this.precedingJoinState = 0;
                break;
              case 4:
                this._oscParser.start();
                break;
              case 5:
                for (let i = s + 1;; i++)
                  if (i >= t || (r = e[i]) < 32 || r > 127 && r < h) {
                    this._oscParser.put(e, s, i), s = i - 1;
                    break;
                  }
                break;
              case 6:
                if (i = this._oscParser.end(r !== 24 && r !== 26), i)
                  return this._preserveStack(5, [], 0, n, s), i;
                r === 27 && (n |= 1), this._params.reset(), this._params.addParam(0), this._collect = 0, this.precedingJoinState = 0;
            }
            this.currentState = 15 & n;
          }
        }
      }
      t.EscapeSequenceParser = c;
    }, 1346: (e, t, s) => {
      Object.defineProperty(t, "__esModule", { value: true }), t.OscHandler = t.OscParser = undefined;
      const i = s(1263), r = s(726), n = [];
      t.OscParser = class {
        constructor() {
          this._state = 0, this._active = n, this._id = -1, this._handlers = Object.create(null), this._handlerFb = () => {}, this._stack = { paused: false, loopPosition: 0, fallThrough: false };
        }
        registerHandler(e, t) {
          this._handlers[e] === undefined && (this._handlers[e] = []);
          const s = this._handlers[e];
          return s.push(t), { dispose: () => {
            const e = s.indexOf(t);
            e !== -1 && s.splice(e, 1);
          } };
        }
        clearHandler(e) {
          this._handlers[e] && delete this._handlers[e];
        }
        setHandlerFallback(e) {
          this._handlerFb = e;
        }
        dispose() {
          this._handlers = Object.create(null), this._handlerFb = () => {}, this._active = n;
        }
        reset() {
          if (this._state === 2)
            for (let e = this._stack.paused ? this._stack.loopPosition - 1 : this._active.length - 1;e >= 0; --e)
              this._active[e].end(false);
          this._stack.paused = false, this._active = n, this._id = -1, this._state = 0;
        }
        _start() {
          if (this._active = this._handlers[this._id] || n, this._active.length)
            for (let e = this._active.length - 1;e >= 0; e--)
              this._active[e].start();
          else
            this._handlerFb(this._id, "START");
        }
        _put(e, t, s) {
          if (this._active.length)
            for (let i = this._active.length - 1;i >= 0; i--)
              this._active[i].put(e, t, s);
          else
            this._handlerFb(this._id, "PUT", (0, r.utf32ToString)(e, t, s));
        }
        start() {
          this.reset(), this._state = 1;
        }
        put(e, t, s) {
          if (this._state !== 3) {
            if (this._state === 1)
              for (;t < s; ) {
                const s = e[t++];
                if (s === 59) {
                  this._state = 2, this._start();
                  break;
                }
                if (s < 48 || 57 < s)
                  return void (this._state = 3);
                this._id === -1 && (this._id = 0), this._id = 10 * this._id + s - 48;
              }
            this._state === 2 && s - t > 0 && this._put(e, t, s);
          }
        }
        end(e, t = true) {
          if (this._state !== 0) {
            if (this._state !== 3)
              if (this._state === 1 && this._start(), this._active.length) {
                let s = false, i = this._active.length - 1, r = false;
                if (this._stack.paused && (i = this._stack.loopPosition - 1, s = t, r = this._stack.fallThrough, this._stack.paused = false), !r && s === false) {
                  for (;i >= 0 && (s = this._active[i].end(e), s !== true); i--)
                    if (s instanceof Promise)
                      return this._stack.paused = true, this._stack.loopPosition = i, this._stack.fallThrough = false, s;
                  i--;
                }
                for (;i >= 0; i--)
                  if (s = this._active[i].end(false), s instanceof Promise)
                    return this._stack.paused = true, this._stack.loopPosition = i, this._stack.fallThrough = true, s;
              } else
                this._handlerFb(this._id, "END", e);
            this._active = n, this._id = -1, this._state = 0;
          }
        }
      }, t.OscHandler = class {
        constructor(e) {
          this._handler = e, this._data = "", this._hitLimit = false;
        }
        start() {
          this._data = "", this._hitLimit = false;
        }
        put(e, t, s) {
          this._hitLimit || (this._data += (0, r.utf32ToString)(e, t, s), this._data.length > i.PAYLOAD_LIMIT && (this._data = "", this._hitLimit = true));
        }
        end(e) {
          let t = false;
          if (this._hitLimit)
            t = false;
          else if (e && (t = this._handler(this._data), t instanceof Promise))
            return t.then((e) => (this._data = "", this._hitLimit = false, e));
          return this._data = "", this._hitLimit = false, t;
        }
      };
    }, 7262: (e, t) => {
      Object.defineProperty(t, "__esModule", { value: true }), t.Params = undefined;
      const s = 2147483647;

      class i {
        static fromArray(e) {
          const t = new i;
          if (!e.length)
            return t;
          for (let s = Array.isArray(e[0]) ? 1 : 0;s < e.length; ++s) {
            const i = e[s];
            if (Array.isArray(i))
              for (let e = 0;e < i.length; ++e)
                t.addSubParam(i[e]);
            else
              t.addParam(i);
          }
          return t;
        }
        constructor(e = 32, t = 32) {
          if (this.maxLength = e, this.maxSubParamsLength = t, t > 256)
            throw new Error("maxSubParamsLength must not be greater than 256");
          this.params = new Int32Array(e), this.length = 0, this._subParams = new Int32Array(t), this._subParamsLength = 0, this._subParamsIdx = new Uint16Array(e), this._rejectDigits = false, this._rejectSubDigits = false, this._digitIsSub = false;
        }
        clone() {
          const e = new i(this.maxLength, this.maxSubParamsLength);
          return e.params.set(this.params), e.length = this.length, e._subParams.set(this._subParams), e._subParamsLength = this._subParamsLength, e._subParamsIdx.set(this._subParamsIdx), e._rejectDigits = this._rejectDigits, e._rejectSubDigits = this._rejectSubDigits, e._digitIsSub = this._digitIsSub, e;
        }
        toArray() {
          const e = [];
          for (let t = 0;t < this.length; ++t) {
            e.push(this.params[t]);
            const s = this._subParamsIdx[t] >> 8, i = 255 & this._subParamsIdx[t];
            i - s > 0 && e.push(Array.prototype.slice.call(this._subParams, s, i));
          }
          return e;
        }
        reset() {
          this.length = 0, this._subParamsLength = 0, this._rejectDigits = false, this._rejectSubDigits = false, this._digitIsSub = false;
        }
        addParam(e) {
          if (this._digitIsSub = false, this.length >= this.maxLength)
            this._rejectDigits = true;
          else {
            if (e < -1)
              throw new Error("values lesser than -1 are not allowed");
            this._subParamsIdx[this.length] = this._subParamsLength << 8 | this._subParamsLength, this.params[this.length++] = e > s ? s : e;
          }
        }
        addSubParam(e) {
          if (this._digitIsSub = true, this.length)
            if (this._rejectDigits || this._subParamsLength >= this.maxSubParamsLength)
              this._rejectSubDigits = true;
            else {
              if (e < -1)
                throw new Error("values lesser than -1 are not allowed");
              this._subParams[this._subParamsLength++] = e > s ? s : e, this._subParamsIdx[this.length - 1]++;
            }
        }
        hasSubParams(e) {
          return (255 & this._subParamsIdx[e]) - (this._subParamsIdx[e] >> 8) > 0;
        }
        getSubParams(e) {
          const t = this._subParamsIdx[e] >> 8, s = 255 & this._subParamsIdx[e];
          return s - t > 0 ? this._subParams.subarray(t, s) : null;
        }
        getSubParamsAll() {
          const e = {};
          for (let t = 0;t < this.length; ++t) {
            const s = this._subParamsIdx[t] >> 8, i = 255 & this._subParamsIdx[t];
            i - s > 0 && (e[t] = this._subParams.slice(s, i));
          }
          return e;
        }
        addDigit(e) {
          let t;
          if (this._rejectDigits || !(t = this._digitIsSub ? this._subParamsLength : this.length) || this._digitIsSub && this._rejectSubDigits)
            return;
          const i = this._digitIsSub ? this._subParams : this.params, r = i[t - 1];
          i[t - 1] = ~r ? Math.min(10 * r + e, s) : e;
        }
      }
      t.Params = i;
    }, 3027: (e, t) => {
      Object.defineProperty(t, "__esModule", { value: true }), t.AddonManager = undefined, t.AddonManager = class {
        constructor() {
          this._addons = [];
        }
        dispose() {
          for (let e = this._addons.length - 1;e >= 0; e--)
            this._addons[e].instance.dispose();
        }
        loadAddon(e, t) {
          const s = { instance: t, dispose: t.dispose, isDisposed: false };
          this._addons.push(s), t.dispose = () => this._wrappedAddonDispose(s), t.activate(e);
        }
        _wrappedAddonDispose(e) {
          if (e.isDisposed)
            return;
          let t = -1;
          for (let s = 0;s < this._addons.length; s++)
            if (this._addons[s] === e) {
              t = s;
              break;
            }
          if (t === -1)
            throw new Error("Could not dispose an addon that has not been loaded");
          e.isDisposed = true, e.dispose.apply(e.instance), this._addons.splice(t, 1);
        }
      };
    }, 3235: (e, t, s) => {
      Object.defineProperty(t, "__esModule", { value: true }), t.BufferApiView = undefined;
      const i = s(793), r = s(3055);
      t.BufferApiView = class {
        constructor(e, t) {
          this._buffer = e, this.type = t;
        }
        init(e) {
          return this._buffer = e, this;
        }
        get cursorY() {
          return this._buffer.y;
        }
        get cursorX() {
          return this._buffer.x;
        }
        get viewportY() {
          return this._buffer.ydisp;
        }
        get baseY() {
          return this._buffer.ybase;
        }
        get length() {
          return this._buffer.lines.length;
        }
        getLine(e) {
          const t = this._buffer.lines.get(e);
          if (t)
            return new i.BufferLineApiView(t);
        }
        getNullCell() {
          return new r.CellData;
        }
      };
    }, 793: (e, t, s) => {
      Object.defineProperty(t, "__esModule", { value: true }), t.BufferLineApiView = undefined;
      const i = s(3055);
      t.BufferLineApiView = class {
        constructor(e) {
          this._line = e;
        }
        get isWrapped() {
          return this._line.isWrapped;
        }
        get length() {
          return this._line.length;
        }
        getCell(e, t) {
          if (!(e < 0 || e >= this._line.length))
            return t ? (this._line.loadCell(e, t), t) : this._line.loadCell(e, new i.CellData);
        }
        translateToString(e, t, s) {
          return this._line.translateToString(e, t, s);
        }
      };
    }, 5101: (e, t, s) => {
      Object.defineProperty(t, "__esModule", { value: true }), t.BufferNamespaceApi = undefined;
      const i = s(3235), r = s(7150), n = s(802);

      class o extends r.Disposable {
        constructor(e) {
          super(), this._core = e, this._onBufferChange = this._register(new n.Emitter), this.onBufferChange = this._onBufferChange.event, this._normal = new i.BufferApiView(this._core.buffers.normal, "normal"), this._alternate = new i.BufferApiView(this._core.buffers.alt, "alternate"), this._core.buffers.onBufferActivate(() => this._onBufferChange.fire(this.active));
        }
        get active() {
          if (this._core.buffers.active === this._core.buffers.normal)
            return this.normal;
          if (this._core.buffers.active === this._core.buffers.alt)
            return this.alternate;
          throw new Error("Active buffer is neither normal nor alternate");
        }
        get normal() {
          return this._normal.init(this._core.buffers.normal);
        }
        get alternate() {
          return this._alternate.init(this._core.buffers.alt);
        }
      }
      t.BufferNamespaceApi = o;
    }, 6097: (e, t) => {
      Object.defineProperty(t, "__esModule", { value: true }), t.ParserApi = undefined, t.ParserApi = class {
        constructor(e) {
          this._core = e;
        }
        registerCsiHandler(e, t) {
          return this._core.registerCsiHandler(e, (e) => t(e.toArray()));
        }
        addCsiHandler(e, t) {
          return this.registerCsiHandler(e, t);
        }
        registerDcsHandler(e, t) {
          return this._core.registerDcsHandler(e, (e, s) => t(e, s.toArray()));
        }
        addDcsHandler(e, t) {
          return this.registerDcsHandler(e, t);
        }
        registerEscHandler(e, t) {
          return this._core.registerEscHandler(e, t);
        }
        addEscHandler(e, t) {
          return this.registerEscHandler(e, t);
        }
        registerOscHandler(e, t) {
          return this._core.registerOscHandler(e, t);
        }
        addOscHandler(e, t) {
          return this.registerOscHandler(e, t);
        }
      };
    }, 4335: (e, t) => {
      Object.defineProperty(t, "__esModule", { value: true }), t.UnicodeApi = undefined, t.UnicodeApi = class {
        constructor(e) {
          this._core = e;
        }
        register(e) {
          this._core.unicodeService.register(e);
        }
        get versions() {
          return this._core.unicodeService.versions;
        }
        get activeVersion() {
          return this._core.unicodeService.activeVersion;
        }
        set activeVersion(e) {
          this._core.unicodeService.activeVersion = e;
        }
      };
    }, 9640: function(e, t, s) {
      var i = this && this.__decorate || function(e, t, s, i) {
        var r, n = arguments.length, o = n < 3 ? t : i === null ? i = Object.getOwnPropertyDescriptor(t, s) : i;
        if (typeof Reflect == "object" && typeof Reflect.decorate == "function")
          o = Reflect.decorate(e, t, s, i);
        else
          for (var a = e.length - 1;a >= 0; a--)
            (r = e[a]) && (o = (n < 3 ? r(o) : n > 3 ? r(t, s, o) : r(t, s)) || o);
        return n > 3 && o && Object.defineProperty(t, s, o), o;
      }, r = this && this.__param || function(e, t) {
        return function(s, i) {
          t(s, i, e);
        };
      };
      Object.defineProperty(t, "__esModule", { value: true }), t.BufferService = t.MINIMUM_ROWS = t.MINIMUM_COLS = undefined;
      const n = s(7150), o = s(4097), a = s(6501), h = s(802);
      t.MINIMUM_COLS = 2, t.MINIMUM_ROWS = 1;
      let c = class extends n.Disposable {
        get buffer() {
          return this.buffers.active;
        }
        constructor(e) {
          super(), this.isUserScrolling = false, this._onResize = this._register(new h.Emitter), this.onResize = this._onResize.event, this._onScroll = this._register(new h.Emitter), this.onScroll = this._onScroll.event, this.cols = Math.max(e.rawOptions.cols || 0, t.MINIMUM_COLS), this.rows = Math.max(e.rawOptions.rows || 0, t.MINIMUM_ROWS), this.buffers = this._register(new o.BufferSet(e, this)), this._register(this.buffers.onBufferActivate((e) => {
            this._onScroll.fire(e.activeBuffer.ydisp);
          }));
        }
        resize(e, t) {
          const s = this.cols !== e, i = this.rows !== t;
          this.cols = e, this.rows = t, this.buffers.resize(e, t), this._onResize.fire({ cols: e, rows: t, colsChanged: s, rowsChanged: i });
        }
        reset() {
          this.buffers.reset(), this.isUserScrolling = false;
        }
        scroll(e, t = false) {
          const s = this.buffer;
          let i;
          i = this._cachedBlankLine, i && i.length === this.cols && i.getFg(0) === e.fg && i.getBg(0) === e.bg || (i = s.getBlankLine(e, t), this._cachedBlankLine = i), i.isWrapped = t;
          const r = s.ybase + s.scrollTop, n = s.ybase + s.scrollBottom;
          if (s.scrollTop === 0) {
            const e = s.lines.isFull;
            n === s.lines.length - 1 ? e ? s.lines.recycle().copyFrom(i) : s.lines.push(i.clone()) : s.lines.splice(n + 1, 0, i.clone()), e ? this.isUserScrolling && (s.ydisp = Math.max(s.ydisp - 1, 0)) : (s.ybase++, this.isUserScrolling || s.ydisp++);
          } else {
            const e = n - r + 1;
            s.lines.shiftElements(r + 1, e - 1, -1), s.lines.set(n, i.clone());
          }
          this.isUserScrolling || (s.ydisp = s.ybase), this._onScroll.fire(s.ydisp);
        }
        scrollLines(e, t) {
          const s = this.buffer;
          if (e < 0) {
            if (s.ydisp === 0)
              return;
            this.isUserScrolling = true;
          } else
            e + s.ydisp >= s.ybase && (this.isUserScrolling = false);
          const i = s.ydisp;
          s.ydisp = Math.max(Math.min(s.ydisp + e, s.ybase), 0), i !== s.ydisp && (t || this._onScroll.fire(s.ydisp));
        }
      };
      t.BufferService = c, t.BufferService = c = i([r(0, a.IOptionsService)], c);
    }, 5746: (e, t) => {
      Object.defineProperty(t, "__esModule", { value: true }), t.CharsetService = undefined, t.CharsetService = class {
        constructor() {
          this.glevel = 0, this._charsets = [];
        }
        reset() {
          this.charset = undefined, this._charsets = [], this.glevel = 0;
        }
        setgLevel(e) {
          this.glevel = e, this.charset = this._charsets[e];
        }
        setgCharset(e, t) {
          this._charsets[e] = t, this.glevel === e && (this.charset = t);
        }
      };
    }, 7792: function(e, t, s) {
      var i = this && this.__decorate || function(e, t, s, i) {
        var r, n = arguments.length, o = n < 3 ? t : i === null ? i = Object.getOwnPropertyDescriptor(t, s) : i;
        if (typeof Reflect == "object" && typeof Reflect.decorate == "function")
          o = Reflect.decorate(e, t, s, i);
        else
          for (var a = e.length - 1;a >= 0; a--)
            (r = e[a]) && (o = (n < 3 ? r(o) : n > 3 ? r(t, s, o) : r(t, s)) || o);
        return n > 3 && o && Object.defineProperty(t, s, o), o;
      }, r = this && this.__param || function(e, t) {
        return function(s, i) {
          t(s, i, e);
        };
      };
      Object.defineProperty(t, "__esModule", { value: true }), t.CoreMouseService = undefined;
      const n = s(6501), o = s(7150), a = s(802), h = { NONE: { events: 0, restrict: () => false }, X10: { events: 1, restrict: (e) => e.button !== 4 && e.action === 1 && (e.ctrl = false, e.alt = false, e.shift = false, true) }, VT200: { events: 19, restrict: (e) => e.action !== 32 }, DRAG: { events: 23, restrict: (e) => e.action !== 32 || e.button !== 3 }, ANY: { events: 31, restrict: (e) => true } };
      function c(e, t) {
        let s = (e.ctrl ? 16 : 0) | (e.shift ? 4 : 0) | (e.alt ? 8 : 0);
        return e.button === 4 ? (s |= 64, s |= e.action) : (s |= 3 & e.button, 4 & e.button && (s |= 64), 8 & e.button && (s |= 128), e.action === 32 ? s |= 32 : e.action !== 0 || t || (s |= 3)), s;
      }
      const l = String.fromCharCode, u = { DEFAULT: (e) => {
        const t = [c(e, false) + 32, e.col + 32, e.row + 32];
        return t[0] > 255 || t[1] > 255 || t[2] > 255 ? "" : `\x1B[M${l(t[0])}${l(t[1])}${l(t[2])}`;
      }, SGR: (e) => {
        const t = e.action === 0 && e.button !== 4 ? "m" : "M";
        return `\x1B[<${c(e, true)};${e.col};${e.row}${t}`;
      }, SGR_PIXELS: (e) => {
        const t = e.action === 0 && e.button !== 4 ? "m" : "M";
        return `\x1B[<${c(e, true)};${e.x};${e.y}${t}`;
      } };
      let d = class extends o.Disposable {
        constructor(e, t, s) {
          super(), this._bufferService = e, this._coreService = t, this._optionsService = s, this._protocols = {}, this._encodings = {}, this._activeProtocol = "", this._activeEncoding = "", this._lastEvent = null, this._wheelPartialScroll = 0, this._onProtocolChange = this._register(new a.Emitter), this.onProtocolChange = this._onProtocolChange.event;
          for (const e of Object.keys(h))
            this.addProtocol(e, h[e]);
          for (const e of Object.keys(u))
            this.addEncoding(e, u[e]);
          this.reset();
        }
        addProtocol(e, t) {
          this._protocols[e] = t;
        }
        addEncoding(e, t) {
          this._encodings[e] = t;
        }
        get activeProtocol() {
          return this._activeProtocol;
        }
        get areMouseEventsActive() {
          return this._protocols[this._activeProtocol].events !== 0;
        }
        set activeProtocol(e) {
          if (!this._protocols[e])
            throw new Error(`unknown protocol "${e}"`);
          this._activeProtocol = e, this._onProtocolChange.fire(this._protocols[e].events);
        }
        get activeEncoding() {
          return this._activeEncoding;
        }
        set activeEncoding(e) {
          if (!this._encodings[e])
            throw new Error(`unknown encoding "${e}"`);
          this._activeEncoding = e;
        }
        reset() {
          this.activeProtocol = "NONE", this.activeEncoding = "DEFAULT", this._lastEvent = null, this._wheelPartialScroll = 0;
        }
        consumeWheelEvent(e, t, s) {
          if (e.deltaY === 0 || e.shiftKey)
            return 0;
          if (t === undefined || s === undefined)
            return 0;
          const i = t / s;
          let r = this._applyScrollModifier(e.deltaY, e);
          return e.deltaMode === WheelEvent.DOM_DELTA_PIXEL ? (r /= i + 0, Math.abs(e.deltaY) < 50 && (r *= 0.3), this._wheelPartialScroll += r, r = Math.floor(Math.abs(this._wheelPartialScroll)) * (this._wheelPartialScroll > 0 ? 1 : -1), this._wheelPartialScroll %= 1) : e.deltaMode === WheelEvent.DOM_DELTA_PAGE && (r *= this._bufferService.rows), r;
        }
        _applyScrollModifier(e, t) {
          return t.altKey || t.ctrlKey || t.shiftKey ? e * this._optionsService.rawOptions.fastScrollSensitivity * this._optionsService.rawOptions.scrollSensitivity : e * this._optionsService.rawOptions.scrollSensitivity;
        }
        triggerMouseEvent(e) {
          if (e.col < 0 || e.col >= this._bufferService.cols || e.row < 0 || e.row >= this._bufferService.rows)
            return false;
          if (e.button === 4 && e.action === 32)
            return false;
          if (e.button === 3 && e.action !== 32)
            return false;
          if (e.button !== 4 && (e.action === 2 || e.action === 3))
            return false;
          if (e.col++, e.row++, e.action === 32 && this._lastEvent && this._equalEvents(this._lastEvent, e, this._activeEncoding === "SGR_PIXELS"))
            return false;
          if (!this._protocols[this._activeProtocol].restrict(e))
            return false;
          const t = this._encodings[this._activeEncoding](e);
          return t && (this._activeEncoding === "DEFAULT" ? this._coreService.triggerBinaryEvent(t) : this._coreService.triggerDataEvent(t, true)), this._lastEvent = e, true;
        }
        explainEvents(e) {
          return { down: !!(1 & e), up: !!(2 & e), drag: !!(4 & e), move: !!(8 & e), wheel: !!(16 & e) };
        }
        _equalEvents(e, t, s) {
          if (s) {
            if (e.x !== t.x)
              return false;
            if (e.y !== t.y)
              return false;
          } else {
            if (e.col !== t.col)
              return false;
            if (e.row !== t.row)
              return false;
          }
          return e.button === t.button && e.action === t.action && e.ctrl === t.ctrl && e.alt === t.alt && e.shift === t.shift;
        }
      };
      t.CoreMouseService = d, t.CoreMouseService = d = i([r(0, n.IBufferService), r(1, n.ICoreService), r(2, n.IOptionsService)], d);
    }, 4071: function(e, t, s) {
      var i = this && this.__decorate || function(e, t, s, i) {
        var r, n = arguments.length, o = n < 3 ? t : i === null ? i = Object.getOwnPropertyDescriptor(t, s) : i;
        if (typeof Reflect == "object" && typeof Reflect.decorate == "function")
          o = Reflect.decorate(e, t, s, i);
        else
          for (var a = e.length - 1;a >= 0; a--)
            (r = e[a]) && (o = (n < 3 ? r(o) : n > 3 ? r(t, s, o) : r(t, s)) || o);
        return n > 3 && o && Object.defineProperty(t, s, o), o;
      }, r = this && this.__param || function(e, t) {
        return function(s, i) {
          t(s, i, e);
        };
      };
      Object.defineProperty(t, "__esModule", { value: true }), t.CoreService = undefined;
      const n = s(7453), o = s(7150), a = s(6501), h = s(802), c = Object.freeze({ insertMode: false }), l = Object.freeze({ applicationCursorKeys: false, applicationKeypad: false, bracketedPasteMode: false, cursorBlink: undefined, cursorStyle: undefined, origin: false, reverseWraparound: false, sendFocus: false, synchronizedOutput: false, wraparound: true });
      let u = class extends o.Disposable {
        constructor(e, t, s) {
          super(), this._bufferService = e, this._logService = t, this._optionsService = s, this.isCursorInitialized = false, this.isCursorHidden = false, this._onData = this._register(new h.Emitter), this.onData = this._onData.event, this._onUserInput = this._register(new h.Emitter), this.onUserInput = this._onUserInput.event, this._onBinary = this._register(new h.Emitter), this.onBinary = this._onBinary.event, this._onRequestScrollToBottom = this._register(new h.Emitter), this.onRequestScrollToBottom = this._onRequestScrollToBottom.event, this.modes = (0, n.clone)(c), this.decPrivateModes = (0, n.clone)(l);
        }
        reset() {
          this.modes = (0, n.clone)(c), this.decPrivateModes = (0, n.clone)(l);
        }
        triggerDataEvent(e, t = false) {
          if (this._optionsService.rawOptions.disableStdin)
            return;
          const s = this._bufferService.buffer;
          t && this._optionsService.rawOptions.scrollOnUserInput && s.ybase !== s.ydisp && this._onRequestScrollToBottom.fire(), t && this._onUserInput.fire(), this._logService.debug(`sending data "${e}"`), this._logService.trace("sending data (codes)", () => e.split("").map((e) => e.charCodeAt(0))), this._onData.fire(e);
        }
        triggerBinaryEvent(e) {
          this._optionsService.rawOptions.disableStdin || (this._logService.debug(`sending binary "${e}"`), this._logService.trace("sending binary (codes)", () => e.split("").map((e) => e.charCodeAt(0))), this._onBinary.fire(e));
        }
      };
      t.CoreService = u, t.CoreService = u = i([r(0, a.IBufferService), r(1, a.ILogService), r(2, a.IOptionsService)], u);
    }, 6025: (e, t, s) => {
      Object.defineProperty(t, "__esModule", { value: true }), t.InstantiationService = t.ServiceCollection = undefined;
      const i = s(6501), r = s(6201);

      class n {
        constructor(...e) {
          this._entries = new Map;
          for (const [t, s] of e)
            this.set(t, s);
        }
        set(e, t) {
          const s = this._entries.get(e);
          return this._entries.set(e, t), s;
        }
        forEach(e) {
          for (const [t, s] of this._entries.entries())
            e(t, s);
        }
        has(e) {
          return this._entries.has(e);
        }
        get(e) {
          return this._entries.get(e);
        }
      }
      t.ServiceCollection = n, t.InstantiationService = class {
        constructor() {
          this._services = new n, this._services.set(i.IInstantiationService, this);
        }
        setService(e, t) {
          this._services.set(e, t);
        }
        getService(e) {
          return this._services.get(e);
        }
        createInstance(e, ...t) {
          const s = (0, r.getServiceDependencies)(e).sort((e, t) => e.index - t.index), i = [];
          for (const t of s) {
            const s = this._services.get(t.id);
            if (!s)
              throw new Error(`[createInstance] ${e.name} depends on UNKNOWN service ${t.id._id}.`);
            i.push(s);
          }
          const n = s.length > 0 ? s[0].index : t.length;
          if (t.length !== n)
            throw new Error(`[createInstance] First service dependency of ${e.name} at position ${n + 1} conflicts with ${t.length} static arguments`);
          return new e(...[...t, ...i]);
        }
      };
    }, 7276: function(e, t, s) {
      var i = this && this.__decorate || function(e, t, s, i) {
        var r, n = arguments.length, o = n < 3 ? t : i === null ? i = Object.getOwnPropertyDescriptor(t, s) : i;
        if (typeof Reflect == "object" && typeof Reflect.decorate == "function")
          o = Reflect.decorate(e, t, s, i);
        else
          for (var a = e.length - 1;a >= 0; a--)
            (r = e[a]) && (o = (n < 3 ? r(o) : n > 3 ? r(t, s, o) : r(t, s)) || o);
        return n > 3 && o && Object.defineProperty(t, s, o), o;
      }, r = this && this.__param || function(e, t) {
        return function(s, i) {
          t(s, i, e);
        };
      };
      Object.defineProperty(t, "__esModule", { value: true }), t.LogService = undefined, t.setTraceLogger = function(e) {
        h = e;
      }, t.traceCall = function(e, t, s) {
        if (typeof s.value != "function")
          throw new Error("not supported");
        const i = s.value;
        s.value = function(...e) {
          if (h.logLevel !== o.LogLevelEnum.TRACE)
            return i.apply(this, e);
          h.trace(`GlyphRenderer#${i.name}(${e.map((e) => JSON.stringify(e)).join(", ")})`);
          const t = i.apply(this, e);
          return h.trace(`GlyphRenderer#${i.name} return`, t), t;
        };
      };
      const n = s(7150), o = s(6501), a = { trace: o.LogLevelEnum.TRACE, debug: o.LogLevelEnum.DEBUG, info: o.LogLevelEnum.INFO, warn: o.LogLevelEnum.WARN, error: o.LogLevelEnum.ERROR, off: o.LogLevelEnum.OFF };
      let h, c = class extends n.Disposable {
        get logLevel() {
          return this._logLevel;
        }
        constructor(e) {
          super(), this._optionsService = e, this._logLevel = o.LogLevelEnum.OFF, this._updateLogLevel(), this._register(this._optionsService.onSpecificOptionChange("logLevel", () => this._updateLogLevel())), h = this;
        }
        _updateLogLevel() {
          this._logLevel = a[this._optionsService.rawOptions.logLevel];
        }
        _evalLazyOptionalParams(e) {
          for (let t = 0;t < e.length; t++)
            typeof e[t] == "function" && (e[t] = e[t]());
        }
        _log(e, t, s) {
          this._evalLazyOptionalParams(s), e.call(console, (this._optionsService.options.logger ? "" : "xterm.js: ") + t, ...s);
        }
        trace(e, ...t) {
          this._logLevel <= o.LogLevelEnum.TRACE && this._log(this._optionsService.options.logger?.trace.bind(this._optionsService.options.logger) ?? console.log, e, t);
        }
        debug(e, ...t) {
          this._logLevel <= o.LogLevelEnum.DEBUG && this._log(this._optionsService.options.logger?.debug.bind(this._optionsService.options.logger) ?? console.log, e, t);
        }
        info(e, ...t) {
          this._logLevel <= o.LogLevelEnum.INFO && this._log(this._optionsService.options.logger?.info.bind(this._optionsService.options.logger) ?? console.info, e, t);
        }
        warn(e, ...t) {
          this._logLevel <= o.LogLevelEnum.WARN && this._log(this._optionsService.options.logger?.warn.bind(this._optionsService.options.logger) ?? console.warn, e, t);
        }
        error(e, ...t) {
          this._logLevel <= o.LogLevelEnum.ERROR && this._log(this._optionsService.options.logger?.error.bind(this._optionsService.options.logger) ?? console.error, e, t);
        }
      };
      t.LogService = c, t.LogService = c = i([r(0, o.IOptionsService)], c);
    }, 56: (e, t, s) => {
      Object.defineProperty(t, "__esModule", { value: true }), t.OptionsService = t.DEFAULT_OPTIONS = undefined;
      const i = s(7150), r = s(701), n = s(802);
      t.DEFAULT_OPTIONS = { cols: 80, rows: 24, cursorBlink: false, cursorStyle: "block", cursorWidth: 1, cursorInactiveStyle: "outline", customGlyphs: true, drawBoldTextInBrightColors: true, documentOverride: null, fastScrollModifier: "alt", fastScrollSensitivity: 5, fontFamily: "monospace", fontSize: 15, fontWeight: "normal", fontWeightBold: "bold", ignoreBracketedPasteMode: false, lineHeight: 1, letterSpacing: 0, linkHandler: null, logLevel: "info", logger: null, scrollback: 1000, scrollOnEraseInDisplay: false, scrollOnUserInput: true, scrollSensitivity: 1, screenReaderMode: false, smoothScrollDuration: 0, macOptionIsMeta: false, macOptionClickForcesSelection: false, minimumContrastRatio: 1, disableStdin: false, allowProposedApi: false, allowTransparency: false, tabStopWidth: 8, theme: {}, reflowCursorLine: false, rescaleOverlappingGlyphs: false, rightClickSelectsWord: r.isMac, windowOptions: {}, windowsMode: false, windowsPty: {}, wordSeparator: " ()[]{}',\"`", altClickMovesCursor: true, convertEol: false, termName: "xterm", cancelEvents: false, overviewRuler: {} };
      const o = ["normal", "bold", "100", "200", "300", "400", "500", "600", "700", "800", "900"];

      class a extends i.Disposable {
        constructor(e) {
          super(), this._onOptionChange = this._register(new n.Emitter), this.onOptionChange = this._onOptionChange.event;
          const s = { ...t.DEFAULT_OPTIONS };
          for (const t in e)
            if (t in s)
              try {
                const i = e[t];
                s[t] = this._sanitizeAndValidateOption(t, i);
              } catch (e) {
                console.error(e);
              }
          this.rawOptions = s, this.options = { ...s }, this._setupOptions(), this._register((0, i.toDisposable)(() => {
            this.rawOptions.linkHandler = null, this.rawOptions.documentOverride = null;
          }));
        }
        onSpecificOptionChange(e, t) {
          return this.onOptionChange((s) => {
            s === e && t(this.rawOptions[e]);
          });
        }
        onMultipleOptionChange(e, t) {
          return this.onOptionChange((s) => {
            e.indexOf(s) !== -1 && t();
          });
        }
        _setupOptions() {
          const e = (e) => {
            if (!(e in t.DEFAULT_OPTIONS))
              throw new Error(`No option with key "${e}"`);
            return this.rawOptions[e];
          }, s = (e, s) => {
            if (!(e in t.DEFAULT_OPTIONS))
              throw new Error(`No option with key "${e}"`);
            s = this._sanitizeAndValidateOption(e, s), this.rawOptions[e] !== s && (this.rawOptions[e] = s, this._onOptionChange.fire(e));
          };
          for (const t in this.rawOptions) {
            const i = { get: e.bind(this, t), set: s.bind(this, t) };
            Object.defineProperty(this.options, t, i);
          }
        }
        _sanitizeAndValidateOption(e, s) {
          switch (e) {
            case "cursorStyle":
              if (s || (s = t.DEFAULT_OPTIONS[e]), !function(e) {
                return e === "block" || e === "underline" || e === "bar";
              }(s))
                throw new Error(`"${s}" is not a valid value for ${e}`);
              break;
            case "wordSeparator":
              s || (s = t.DEFAULT_OPTIONS[e]);
              break;
            case "fontWeight":
            case "fontWeightBold":
              if (typeof s == "number" && 1 <= s && s <= 1000)
                break;
              s = o.includes(s) ? s : t.DEFAULT_OPTIONS[e];
              break;
            case "cursorWidth":
              s = Math.floor(s);
            case "lineHeight":
            case "tabStopWidth":
              if (s < 1)
                throw new Error(`${e} cannot be less than 1, value: ${s}`);
              break;
            case "minimumContrastRatio":
              s = Math.max(1, Math.min(21, Math.round(10 * s) / 10));
              break;
            case "scrollback":
              if ((s = Math.min(s, 4294967295)) < 0)
                throw new Error(`${e} cannot be less than 0, value: ${s}`);
              break;
            case "fastScrollSensitivity":
            case "scrollSensitivity":
              if (s <= 0)
                throw new Error(`${e} cannot be less than or equal to 0, value: ${s}`);
              break;
            case "rows":
            case "cols":
              if (!s && s !== 0)
                throw new Error(`${e} must be numeric, value: ${s}`);
              break;
            case "windowsPty":
              s = s ?? {};
          }
          return s;
        }
      }
      t.OptionsService = a;
    }, 8811: function(e, t, s) {
      var i = this && this.__decorate || function(e, t, s, i) {
        var r, n = arguments.length, o = n < 3 ? t : i === null ? i = Object.getOwnPropertyDescriptor(t, s) : i;
        if (typeof Reflect == "object" && typeof Reflect.decorate == "function")
          o = Reflect.decorate(e, t, s, i);
        else
          for (var a = e.length - 1;a >= 0; a--)
            (r = e[a]) && (o = (n < 3 ? r(o) : n > 3 ? r(t, s, o) : r(t, s)) || o);
        return n > 3 && o && Object.defineProperty(t, s, o), o;
      }, r = this && this.__param || function(e, t) {
        return function(s, i) {
          t(s, i, e);
        };
      };
      Object.defineProperty(t, "__esModule", { value: true }), t.OscLinkService = undefined;
      const n = s(6501);
      let o = class {
        constructor(e) {
          this._bufferService = e, this._nextId = 1, this._entriesWithId = new Map, this._dataByLinkId = new Map;
        }
        registerLink(e) {
          const t = this._bufferService.buffer;
          if (e.id === undefined) {
            const s = t.addMarker(t.ybase + t.y), i = { data: e, id: this._nextId++, lines: [s] };
            return s.onDispose(() => this._removeMarkerFromLink(i, s)), this._dataByLinkId.set(i.id, i), i.id;
          }
          const s = e, i = this._getEntryIdKey(s), r = this._entriesWithId.get(i);
          if (r)
            return this.addLineToLink(r.id, t.ybase + t.y), r.id;
          const n = t.addMarker(t.ybase + t.y), o = { id: this._nextId++, key: this._getEntryIdKey(s), data: s, lines: [n] };
          return n.onDispose(() => this._removeMarkerFromLink(o, n)), this._entriesWithId.set(o.key, o), this._dataByLinkId.set(o.id, o), o.id;
        }
        addLineToLink(e, t) {
          const s = this._dataByLinkId.get(e);
          if (s && s.lines.every((e) => e.line !== t)) {
            const e = this._bufferService.buffer.addMarker(t);
            s.lines.push(e), e.onDispose(() => this._removeMarkerFromLink(s, e));
          }
        }
        getLinkData(e) {
          return this._dataByLinkId.get(e)?.data;
        }
        _getEntryIdKey(e) {
          return `${e.id};;${e.uri}`;
        }
        _removeMarkerFromLink(e, t) {
          const s = e.lines.indexOf(t);
          s !== -1 && (e.lines.splice(s, 1), e.lines.length === 0 && (e.data.id !== undefined && this._entriesWithId.delete(e.key), this._dataByLinkId.delete(e.id)));
        }
      };
      t.OscLinkService = o, t.OscLinkService = o = i([r(0, n.IBufferService)], o);
    }, 6201: (e, t) => {
      Object.defineProperty(t, "__esModule", { value: true }), t.serviceRegistry = undefined, t.getServiceDependencies = function(e) {
        return e[i] || [];
      }, t.createDecorator = function(e) {
        if (t.serviceRegistry.has(e))
          return t.serviceRegistry.get(e);
        const r = function(e, t, n) {
          if (arguments.length !== 3)
            throw new Error("@IServiceName-decorator can only be used to decorate a parameter");
          (function(e, t, r) {
            t[s] === t ? t[i].push({ id: e, index: r }) : (t[i] = [{ id: e, index: r }], t[s] = t);
          })(r, e, n);
        };
        return r._id = e, t.serviceRegistry.set(e, r), r;
      };
      const s = "di$target", i = "di$dependencies";
      t.serviceRegistry = new Map;
    }, 6501: (e, t, s) => {
      Object.defineProperty(t, "__esModule", { value: true }), t.IDecorationService = t.IUnicodeService = t.IOscLinkService = t.IOptionsService = t.ILogService = t.LogLevelEnum = t.IInstantiationService = t.ICharsetService = t.ICoreService = t.ICoreMouseService = t.IBufferService = undefined;
      const i = s(6201);
      var r;
      t.IBufferService = (0, i.createDecorator)("BufferService"), t.ICoreMouseService = (0, i.createDecorator)("CoreMouseService"), t.ICoreService = (0, i.createDecorator)("CoreService"), t.ICharsetService = (0, i.createDecorator)("CharsetService"), t.IInstantiationService = (0, i.createDecorator)("InstantiationService"), function(e) {
        e[e.TRACE = 0] = "TRACE", e[e.DEBUG = 1] = "DEBUG", e[e.INFO = 2] = "INFO", e[e.WARN = 3] = "WARN", e[e.ERROR = 4] = "ERROR", e[e.OFF = 5] = "OFF";
      }(r || (t.LogLevelEnum = r = {})), t.ILogService = (0, i.createDecorator)("LogService"), t.IOptionsService = (0, i.createDecorator)("OptionsService"), t.IOscLinkService = (0, i.createDecorator)("OscLinkService"), t.IUnicodeService = (0, i.createDecorator)("UnicodeService"), t.IDecorationService = (0, i.createDecorator)("DecorationService");
    }, 6415: (e, t, s) => {
      Object.defineProperty(t, "__esModule", { value: true }), t.UnicodeService = undefined;
      const i = s(7428), r = s(802);

      class n {
        static extractShouldJoin(e) {
          return !!(1 & e);
        }
        static extractWidth(e) {
          return e >> 1 & 3;
        }
        static extractCharKind(e) {
          return e >> 3;
        }
        static createPropertyValue(e, t, s = false) {
          return (16777215 & e) << 3 | (3 & t) << 1 | (s ? 1 : 0);
        }
        constructor() {
          this._providers = Object.create(null), this._active = "", this._onChange = new r.Emitter, this.onChange = this._onChange.event;
          const e = new i.UnicodeV6;
          this.register(e), this._active = e.version, this._activeProvider = e;
        }
        dispose() {
          this._onChange.dispose();
        }
        get versions() {
          return Object.keys(this._providers);
        }
        get activeVersion() {
          return this._active;
        }
        set activeVersion(e) {
          if (!this._providers[e])
            throw new Error(`unknown Unicode version "${e}"`);
          this._active = e, this._activeProvider = this._providers[e], this._onChange.fire(e);
        }
        register(e) {
          this._providers[e.version] = e;
        }
        wcwidth(e) {
          return this._activeProvider.wcwidth(e);
        }
        getStringCellWidth(e) {
          let t = 0, s = 0;
          const i = e.length;
          for (let r = 0;r < i; ++r) {
            let o = e.charCodeAt(r);
            if (55296 <= o && o <= 56319) {
              if (++r >= i)
                return t + this.wcwidth(o);
              const s = e.charCodeAt(r);
              56320 <= s && s <= 57343 ? o = 1024 * (o - 55296) + s - 56320 + 65536 : t += this.wcwidth(s);
            }
            const a = this.charProperties(o, s);
            let h = n.extractWidth(a);
            n.extractShouldJoin(a) && (h -= n.extractWidth(s)), t += h, s = a;
          }
          return t;
        }
        charProperties(e, t) {
          return this._activeProvider.charProperties(e, t);
        }
      }
      t.UnicodeService = n;
    }, 5856: (e, t, s) => {
      Object.defineProperty(t, "__esModule", { value: true }), t.Terminal = undefined;
      const i = s(6107), r = s(5777), n = s(802);

      class o extends r.CoreTerminal {
        constructor(e = {}) {
          super(e), this._onBell = this._register(new n.Emitter), this.onBell = this._onBell.event, this._onCursorMove = this._register(new n.Emitter), this.onCursorMove = this._onCursorMove.event, this._onTitleChange = this._register(new n.Emitter), this.onTitleChange = this._onTitleChange.event, this._onA11yCharEmitter = this._register(new n.Emitter), this.onA11yChar = this._onA11yCharEmitter.event, this._onA11yTabEmitter = this._register(new n.Emitter), this.onA11yTab = this._onA11yTabEmitter.event, this._setup(), this._register(this._inputHandler.onRequestBell(() => this.bell())), this._register(this._inputHandler.onRequestReset(() => this.reset())), this._register(n.Event.forward(this._inputHandler.onCursorMove, this._onCursorMove)), this._register(n.Event.forward(this._inputHandler.onTitleChange, this._onTitleChange)), this._register(n.Event.forward(this._inputHandler.onA11yChar, this._onA11yCharEmitter)), this._register(n.Event.forward(this._inputHandler.onA11yTab, this._onA11yTabEmitter));
        }
        get buffer() {
          return this.buffers.active;
        }
        get markers() {
          return this.buffer.markers;
        }
        addMarker(e) {
          if (this.buffer === this.buffers.normal)
            return this.buffer.addMarker(this.buffer.ybase + this.buffer.y + e);
        }
        bell() {
          this._onBell.fire();
        }
        input(e, t = true) {
          this.coreService.triggerDataEvent(e, t);
        }
        resize(e, t) {
          e === this.cols && t === this.rows || super.resize(e, t);
        }
        clear() {
          if (this.buffer.ybase !== 0 || this.buffer.y !== 0) {
            this.buffer.lines.set(0, this.buffer.lines.get(this.buffer.ybase + this.buffer.y)), this.buffer.lines.length = 1, this.buffer.ydisp = 0, this.buffer.ybase = 0, this.buffer.y = 0;
            for (let e = 1;e < this.rows; e++)
              this.buffer.lines.push(this.buffer.getBlankLine(i.DEFAULT_ATTR_DATA));
            this._onScroll.fire({ position: this.buffer.ydisp });
          }
        }
        reset() {
          this.options.rows = this.rows, this.options.cols = this.cols, this._setup(), super.reset();
        }
      }
      t.Terminal = o;
    }, 3058: (e, t, s) => {
      Object.defineProperty(t, "__esModule", { value: true }), t.Permutation = t.CallbackIterable = t.ArrayQueue = t.booleanComparator = t.numberComparator = t.CompareResult = undefined, t.tail = function(e, t = 0) {
        return e[e.length - (1 + t)];
      }, t.tail2 = function(e) {
        if (e.length === 0)
          throw new Error("Invalid tail call");
        return [e.slice(0, e.length - 1), e[e.length - 1]];
      }, t.equals = function(e, t, s = (e, t) => e === t) {
        if (e === t)
          return true;
        if (!e || !t)
          return false;
        if (e.length !== t.length)
          return false;
        for (let i = 0, r = e.length;i < r; i++)
          if (!s(e[i], t[i]))
            return false;
        return true;
      }, t.removeFastWithoutKeepingOrder = function(e, t) {
        const s = e.length - 1;
        t < s && (e[t] = e[s]), e.pop();
      }, t.binarySearch = function(e, t, s) {
        return n(e.length, (i) => s(e[i], t));
      }, t.binarySearch2 = n, t.quickSelect = function e(t, s, i) {
        if ((t |= 0) >= s.length)
          throw new TypeError("invalid index");
        const r = s[Math.floor(s.length * Math.random())], n = [], o = [], a = [];
        for (const e of s) {
          const t = i(e, r);
          t < 0 ? n.push(e) : t > 0 ? o.push(e) : a.push(e);
        }
        return t < n.length ? e(t, n, i) : t < n.length + a.length ? a[0] : e(t - (n.length + a.length), o, i);
      }, t.groupBy = function(e, t) {
        const s = [];
        let i;
        for (const r of e.slice(0).sort(t))
          i && t(i[0], r) === 0 ? i.push(r) : (i = [r], s.push(i));
        return s;
      }, t.groupAdjacentBy = function* (e, t) {
        let s, i;
        for (const r of e)
          i !== undefined && t(i, r) ? s.push(r) : (s && (yield s), s = [r]), i = r;
        s && (yield s);
      }, t.forEachAdjacent = function(e, t) {
        for (let s = 0;s <= e.length; s++)
          t(s === 0 ? undefined : e[s - 1], s === e.length ? undefined : e[s]);
      }, t.forEachWithNeighbors = function(e, t) {
        for (let s = 0;s < e.length; s++)
          t(s === 0 ? undefined : e[s - 1], e[s], s + 1 === e.length ? undefined : e[s + 1]);
      }, t.sortedDiff = o, t.delta = function(e, t, s) {
        const i = o(e, t, s), r = [], n = [];
        for (const t of i)
          r.push(...e.slice(t.start, t.start + t.deleteCount)), n.push(...t.toInsert);
        return { removed: r, added: n };
      }, t.top = function(e, t, s) {
        if (s === 0)
          return [];
        const i = e.slice(0, s).sort(t);
        return a(e, t, i, s, e.length), i;
      }, t.topAsync = function(e, t, s, r, n) {
        return s === 0 ? Promise.resolve([]) : new Promise((o, h) => {
          (async () => {
            const o = e.length, h = e.slice(0, s).sort(t);
            for (let c = s, l = Math.min(s + r, o);c < o; c = l, l = Math.min(l + r, o)) {
              if (c > s && await new Promise((e) => setTimeout(e)), n && n.isCancellationRequested)
                throw new i.CancellationError;
              a(e, t, h, c, l);
            }
            return h;
          })().then(o, h);
        });
      }, t.coalesce = function(e) {
        return e.filter((e) => !!e);
      }, t.coalesceInPlace = function(e) {
        let t = 0;
        for (let s = 0;s < e.length; s++)
          e[s] && (e[t] = e[s], t += 1);
        e.length = t;
      }, t.move = function(e, t, s) {
        e.splice(s, 0, e.splice(t, 1)[0]);
      }, t.isFalsyOrEmpty = function(e) {
        return !Array.isArray(e) || e.length === 0;
      }, t.isNonEmptyArray = function(e) {
        return Array.isArray(e) && e.length > 0;
      }, t.distinct = function(e, t = (e) => e) {
        const s = new Set;
        return e.filter((e) => {
          const i = t(e);
          return !s.has(i) && (s.add(i), true);
        });
      }, t.uniqueFilter = function(e) {
        const t = new Set;
        return (s) => {
          const i = e(s);
          return !t.has(i) && (t.add(i), true);
        };
      }, t.firstOrDefault = function(e, t) {
        return e.length > 0 ? e[0] : t;
      }, t.lastOrDefault = function(e, t) {
        return e.length > 0 ? e[e.length - 1] : t;
      }, t.commonPrefixLength = function(e, t, s = (e, t) => e === t) {
        let i = 0;
        for (let r = 0, n = Math.min(e.length, t.length);r < n && s(e[r], t[r]); r++)
          i++;
        return i;
      }, t.range = function(e, t) {
        let s = typeof t == "number" ? e : 0;
        typeof t == "number" ? s = e : (s = 0, t = e);
        const i = [];
        if (s <= t)
          for (let e = s;e < t; e++)
            i.push(e);
        else
          for (let e = s;e > t; e--)
            i.push(e);
        return i;
      }, t.index = function(e, t, s) {
        return e.reduce((e, i) => (e[t(i)] = s ? s(i) : i, e), Object.create(null));
      }, t.insert = function(e, t) {
        return e.push(t), () => h(e, t);
      }, t.remove = h, t.arrayInsert = function(e, t, s) {
        const i = e.slice(0, t), r = e.slice(t);
        return i.concat(s, r);
      }, t.shuffle = function(e, t) {
        let s;
        if (typeof t == "number") {
          let e = t;
          s = () => {
            const t = 179426549 * Math.sin(e++);
            return t - Math.floor(t);
          };
        } else
          s = Math.random;
        for (let t = e.length - 1;t > 0; t -= 1) {
          const i = Math.floor(s() * (t + 1)), r = e[t];
          e[t] = e[i], e[i] = r;
        }
      }, t.pushToStart = function(e, t) {
        const s = e.indexOf(t);
        s > -1 && (e.splice(s, 1), e.unshift(t));
      }, t.pushToEnd = function(e, t) {
        const s = e.indexOf(t);
        s > -1 && (e.splice(s, 1), e.push(t));
      }, t.pushMany = function(e, t) {
        for (const s of t)
          e.push(s);
      }, t.mapArrayOrNot = function(e, t) {
        return Array.isArray(e) ? e.map(t) : t(e);
      }, t.asArray = function(e) {
        return Array.isArray(e) ? e : [e];
      }, t.getRandomElement = function(e) {
        return e[Math.floor(Math.random() * e.length)];
      }, t.insertInto = c, t.splice = function(e, t, s, i) {
        const r = l(e, t);
        let n = e.splice(r, s);
        return n === undefined && (n = []), c(e, r, i), n;
      }, t.compareBy = function(e, t) {
        return (s, i) => t(e(s), e(i));
      }, t.tieBreakComparators = function(...e) {
        return (t, s) => {
          for (const i of e) {
            const e = i(t, s);
            if (!u.isNeitherLessOrGreaterThan(e))
              return e;
          }
          return u.neitherLessOrGreaterThan;
        };
      }, t.reverseOrder = function(e) {
        return (t, s) => -e(t, s);
      };
      const i = s(9807), r = s(8297);
      function n(e, t) {
        let s = 0, i = e - 1;
        for (;s <= i; ) {
          const e = (s + i) / 2 | 0, r = t(e);
          if (r < 0)
            s = e + 1;
          else {
            if (!(r > 0))
              return e;
            i = e - 1;
          }
        }
        return -(s + 1);
      }
      function o(e, t, s) {
        const i = [];
        function r(e, t, s) {
          if (t === 0 && s.length === 0)
            return;
          const r = i[i.length - 1];
          r && r.start + r.deleteCount === e ? (r.deleteCount += t, r.toInsert.push(...s)) : i.push({ start: e, deleteCount: t, toInsert: s });
        }
        let n = 0, o = 0;
        for (;; ) {
          if (n === e.length) {
            r(n, 0, t.slice(o));
            break;
          }
          if (o === t.length) {
            r(n, e.length - n, []);
            break;
          }
          const i = e[n], a = t[o], h = s(i, a);
          h === 0 ? (n += 1, o += 1) : h < 0 ? (r(n, 1, []), n += 1) : h > 0 && (r(n, 0, [a]), o += 1);
        }
        return i;
      }
      function a(e, t, s, i, n) {
        for (const o = s.length;i < n; i++) {
          const n = e[i];
          if (t(n, s[o - 1]) < 0) {
            s.pop();
            const e = (0, r.findFirstIdxMonotonousOrArrLen)(s, (e) => t(n, e) < 0);
            s.splice(e, 0, n);
          }
        }
      }
      function h(e, t) {
        const s = e.indexOf(t);
        if (s > -1)
          return e.splice(s, 1), t;
      }
      function c(e, t, s) {
        const i = l(e, t), r = e.length, n = s.length;
        e.length = r + n;
        for (let t = r - 1;t >= i; t--)
          e[t + n] = e[t];
        for (let t = 0;t < n; t++)
          e[t + i] = s[t];
      }
      function l(e, t) {
        return t < 0 ? Math.max(t + e.length, 0) : Math.min(t, e.length);
      }
      var u;
      (function(e) {
        e.isLessThan = function(e) {
          return e < 0;
        }, e.isLessThanOrEqual = function(e) {
          return e <= 0;
        }, e.isGreaterThan = function(e) {
          return e > 0;
        }, e.isNeitherLessOrGreaterThan = function(e) {
          return e === 0;
        }, e.greaterThan = 1, e.lessThan = -1, e.neitherLessOrGreaterThan = 0;
      })(u || (t.CompareResult = u = {})), t.numberComparator = (e, t) => e - t, t.booleanComparator = (e, s) => (0, t.numberComparator)(e ? 1 : 0, s ? 1 : 0), t.ArrayQueue = class {
        constructor(e) {
          this.items = e, this.firstIdx = 0, this.lastIdx = this.items.length - 1;
        }
        get length() {
          return this.lastIdx - this.firstIdx + 1;
        }
        takeWhile(e) {
          let t = this.firstIdx;
          for (;t < this.items.length && e(this.items[t]); )
            t++;
          const s = t === this.firstIdx ? null : this.items.slice(this.firstIdx, t);
          return this.firstIdx = t, s;
        }
        takeFromEndWhile(e) {
          let t = this.lastIdx;
          for (;t >= 0 && e(this.items[t]); )
            t--;
          const s = t === this.lastIdx ? null : this.items.slice(t + 1, this.lastIdx + 1);
          return this.lastIdx = t, s;
        }
        peek() {
          if (this.length !== 0)
            return this.items[this.firstIdx];
        }
        peekLast() {
          if (this.length !== 0)
            return this.items[this.lastIdx];
        }
        dequeue() {
          const e = this.items[this.firstIdx];
          return this.firstIdx++, e;
        }
        removeLast() {
          const e = this.items[this.lastIdx];
          return this.lastIdx--, e;
        }
        takeCount(e) {
          const t = this.items.slice(this.firstIdx, this.firstIdx + e);
          return this.firstIdx += e, t;
        }
      };

      class d {
        static {
          this.empty = new d((e) => {});
        }
        constructor(e) {
          this.iterate = e;
        }
        forEach(e) {
          this.iterate((t) => (e(t), true));
        }
        toArray() {
          const e = [];
          return this.iterate((t) => (e.push(t), true)), e;
        }
        filter(e) {
          return new d((t) => this.iterate((s) => !e(s) || t(s)));
        }
        map(e) {
          return new d((t) => this.iterate((s) => t(e(s))));
        }
        some(e) {
          let t = false;
          return this.iterate((s) => (t = e(s), !t)), t;
        }
        findFirst(e) {
          let t;
          return this.iterate((s) => !e(s) || (t = s, false)), t;
        }
        findLast(e) {
          let t;
          return this.iterate((s) => (e(s) && (t = s), true)), t;
        }
        findLastMaxBy(e) {
          let t, s = true;
          return this.iterate((i) => ((s || u.isGreaterThan(e(i, t))) && (s = false, t = i), true)), t;
        }
      }
      t.CallbackIterable = d;

      class f {
        constructor(e) {
          this._indexMap = e;
        }
        static createSortPermutation(e, t) {
          const s = Array.from(e.keys()).sort((s, i) => t(e[s], e[i]));
          return new f(s);
        }
        apply(e) {
          return e.map((t, s) => e[this._indexMap[s]]);
        }
        inverse() {
          const e = this._indexMap.slice();
          for (let t = 0;t < this._indexMap.length; t++)
            e[this._indexMap[t]] = t;
          return new f(e);
        }
      }
      t.Permutation = f;
    }, 8297: (e, t) => {
      function s(e, t, s = e.length - 1) {
        for (let i = s;i >= 0; i--)
          if (t(e[i]))
            return i;
        return -1;
      }
      function i(e, t, s = 0, i = e.length) {
        let r = s, n = i;
        for (;r < n; ) {
          const s = Math.floor((r + n) / 2);
          t(e[s]) ? r = s + 1 : n = s;
        }
        return r - 1;
      }
      function r(e, t, s = 0, i = e.length) {
        let r = s, n = i;
        for (;r < n; ) {
          const s = Math.floor((r + n) / 2);
          t(e[s]) ? n = s : r = s + 1;
        }
        return r;
      }
      Object.defineProperty(t, "__esModule", { value: true }), t.MonotonousArray = undefined, t.findLast = function(e, t) {
        const i = s(e, t);
        if (i !== -1)
          return e[i];
      }, t.findLastIdx = s, t.findLastMonotonous = function(e, t) {
        const s = i(e, t);
        return s === -1 ? undefined : e[s];
      }, t.findLastIdxMonotonous = i, t.findFirstMonotonous = function(e, t) {
        const s = r(e, t);
        return s === e.length ? undefined : e[s];
      }, t.findFirstIdxMonotonousOrArrLen = r, t.findFirstIdxMonotonous = function(e, t, s = 0, i = e.length) {
        const n = r(e, t, s, i);
        return n === e.length ? -1 : n;
      }, t.findFirstMax = o, t.findLastMax = function(e, t) {
        if (e.length === 0)
          return;
        let s = e[0];
        for (let i = 1;i < e.length; i++) {
          const r = e[i];
          t(r, s) >= 0 && (s = r);
        }
        return s;
      }, t.findFirstMin = function(e, t) {
        return o(e, (e, s) => -t(e, s));
      }, t.findMaxIdx = function(e, t) {
        if (e.length === 0)
          return -1;
        let s = 0;
        for (let i = 1;i < e.length; i++)
          t(e[i], e[s]) > 0 && (s = i);
        return s;
      }, t.mapFindFirst = function(e, t) {
        for (const s of e) {
          const e = t(s);
          if (e !== undefined)
            return e;
        }
      };

      class n {
        static {
          this.assertInvariants = false;
        }
        constructor(e) {
          this._array = e, this._findLastMonotonousLastIdx = 0;
        }
        findLastMonotonous(e) {
          if (n.assertInvariants) {
            if (this._prevFindLastPredicate) {
              for (const t of this._array)
                if (this._prevFindLastPredicate(t) && !e(t))
                  throw new Error("MonotonousArray: current predicate must be weaker than (or equal to) the previous predicate.");
            }
            this._prevFindLastPredicate = e;
          }
          const t = i(this._array, e, this._findLastMonotonousLastIdx);
          return this._findLastMonotonousLastIdx = t + 1, t === -1 ? undefined : this._array[t];
        }
      }
      function o(e, t) {
        if (e.length === 0)
          return;
        let s = e[0];
        for (let i = 1;i < e.length; i++) {
          const r = e[i];
          t(r, s) > 0 && (s = r);
        }
        return s;
      }
      t.MonotonousArray = n;
    }, 9087: (e, t) => {
      var s;
      Object.defineProperty(t, "__esModule", { value: true }), t.SetWithKey = undefined, t.groupBy = function(e, t) {
        const s = Object.create(null);
        for (const i of e) {
          const e = t(i);
          let r = s[e];
          r || (r = s[e] = []), r.push(i);
        }
        return s;
      }, t.diffSets = function(e, t) {
        const s = [], i = [];
        for (const i of e)
          t.has(i) || s.push(i);
        for (const s of t)
          e.has(s) || i.push(s);
        return { removed: s, added: i };
      }, t.diffMaps = function(e, t) {
        const s = [], i = [];
        for (const [i, r] of e)
          t.has(i) || s.push(r);
        for (const [s, r] of t)
          e.has(s) || i.push(r);
        return { removed: s, added: i };
      }, t.intersection = function(e, t) {
        const s = new Set;
        for (const i of t)
          e.has(i) && s.add(i);
        return s;
      };

      class i {
        static {
          s = Symbol.toStringTag;
        }
        constructor(e, t) {
          this.toKey = t, this._map = new Map, this[s] = "SetWithKey";
          for (const t of e)
            this.add(t);
        }
        get size() {
          return this._map.size;
        }
        add(e) {
          const t = this.toKey(e);
          return this._map.set(t, e), this;
        }
        delete(e) {
          return this._map.delete(this.toKey(e));
        }
        has(e) {
          return this._map.has(this.toKey(e));
        }
        *entries() {
          for (const e of this._map.values())
            yield [e, e];
        }
        keys() {
          return this.values();
        }
        *values() {
          for (const e of this._map.values())
            yield e;
        }
        clear() {
          this._map.clear();
        }
        forEach(e, t) {
          this._map.forEach((s) => e.call(t, s, s, this));
        }
        [Symbol.iterator]() {
          return this.values();
        }
      }
      t.SetWithKey = i;
    }, 9807: (e, t) => {
      Object.defineProperty(t, "__esModule", { value: true }), t.BugIndicatingError = t.ErrorNoTelemetry = t.ExpectedError = t.NotSupportedError = t.NotImplementedError = t.ReadonlyError = t.CancellationError = t.errorHandler = t.ErrorHandler = undefined, t.setUnexpectedErrorHandler = function(e) {
        t.errorHandler.setUnexpectedErrorHandler(e);
      }, t.isSigPipeError = function(e) {
        if (!e || typeof e != "object")
          return false;
        const t = e;
        return t.code === "EPIPE" && t.syscall?.toUpperCase() === "WRITE";
      }, t.onUnexpectedError = function(e) {
        r(e) || t.errorHandler.onUnexpectedError(e);
      }, t.onUnexpectedExternalError = function(e) {
        r(e) || t.errorHandler.onUnexpectedExternalError(e);
      }, t.transformErrorForSerialization = function(e) {
        if (e instanceof Error) {
          const { name: t, message: s } = e;
          return { $isError: true, name: t, message: s, stack: e.stacktrace || e.stack, noTelemetry: l.isErrorNoTelemetry(e) };
        }
        return e;
      }, t.transformErrorFromSerialization = function(e) {
        let t;
        return e.noTelemetry ? t = new l : (t = new Error, t.name = e.name), t.message = e.message, t.stack = e.stack, t;
      }, t.isCancellationError = r, t.canceled = function() {
        const e = new Error(i);
        return e.name = e.message, e;
      }, t.illegalArgument = function(e) {
        return e ? new Error(`Illegal argument: ${e}`) : new Error("Illegal argument");
      }, t.illegalState = function(e) {
        return e ? new Error(`Illegal state: ${e}`) : new Error("Illegal state");
      }, t.getErrorMessage = function(e) {
        return e ? e.message ? e.message : e.stack ? e.stack.split(`
`)[0] : String(e) : "Error";
      };

      class s {
        constructor() {
          this.listeners = [], this.unexpectedErrorHandler = function(e) {
            setTimeout(() => {
              if (e.stack) {
                if (l.isErrorNoTelemetry(e))
                  throw new l(e.message + `

` + e.stack);
                throw new Error(e.message + `

` + e.stack);
              }
              throw e;
            }, 0);
          };
        }
        addListener(e) {
          return this.listeners.push(e), () => {
            this._removeListener(e);
          };
        }
        emit(e) {
          this.listeners.forEach((t) => {
            t(e);
          });
        }
        _removeListener(e) {
          this.listeners.splice(this.listeners.indexOf(e), 1);
        }
        setUnexpectedErrorHandler(e) {
          this.unexpectedErrorHandler = e;
        }
        getUnexpectedErrorHandler() {
          return this.unexpectedErrorHandler;
        }
        onUnexpectedError(e) {
          this.unexpectedErrorHandler(e), this.emit(e);
        }
        onUnexpectedExternalError(e) {
          this.unexpectedErrorHandler(e);
        }
      }
      t.ErrorHandler = s, t.errorHandler = new s;
      const i = "Canceled";
      function r(e) {
        return e instanceof n || e instanceof Error && e.name === i && e.message === i;
      }

      class n extends Error {
        constructor() {
          super(i), this.name = this.message;
        }
      }
      t.CancellationError = n;

      class o extends TypeError {
        constructor(e) {
          super(e ? `${e} is read-only and cannot be changed` : "Cannot change read-only property");
        }
      }
      t.ReadonlyError = o;

      class a extends Error {
        constructor(e) {
          super("NotImplemented"), e && (this.message = e);
        }
      }
      t.NotImplementedError = a;

      class h extends Error {
        constructor(e) {
          super("NotSupported"), e && (this.message = e);
        }
      }
      t.NotSupportedError = h;

      class c extends Error {
        constructor() {
          super(...arguments), this.isExpected = true;
        }
      }
      t.ExpectedError = c;

      class l extends Error {
        constructor(e) {
          super(e), this.name = "CodeExpectedError";
        }
        static fromError(e) {
          if (e instanceof l)
            return e;
          const t = new l;
          return t.message = e.message, t.stack = e.stack, t;
        }
        static isErrorNoTelemetry(e) {
          return e.name === "CodeExpectedError";
        }
      }
      t.ErrorNoTelemetry = l;

      class u extends Error {
        constructor(e) {
          super(e || "An unexpected bug occurred."), Object.setPrototypeOf(this, u.prototype);
        }
      }
      t.BugIndicatingError = u;
    }, 802: (e, t, s) => {
      Object.defineProperty(t, "__esModule", { value: true }), t.ValueWithChangeEvent = t.Relay = t.EventBufferer = t.DynamicListEventMultiplexer = t.EventMultiplexer = t.MicrotaskEmitter = t.DebounceEmitter = t.PauseableEmitter = t.AsyncEmitter = t.createEventDeliveryQueue = t.Emitter = t.ListenerRefusalError = t.ListenerLeakError = t.EventProfiling = t.Event = undefined, t.setGlobalLeakWarningThreshold = function(e) {
        const t = l;
        return l = e, { dispose() {
          l = t;
        } };
      };
      const i = s(9807), r = s(8841), n = s(7150), o = s(6317), a = s(9725);
      var h;
      (function(e) {
        function t(e) {
          return (t, s = null, i) => {
            let r, n = false;
            return r = e((e) => {
              if (!n)
                return r ? r.dispose() : n = true, t.call(s, e);
            }, null, i), n && r.dispose(), r;
          };
        }
        function s(e, t, s) {
          return r((s, i = null, r) => e((e) => s.call(i, t(e)), null, r), s);
        }
        function i(e, t, s) {
          return r((s, i = null, r) => e((e) => t(e) && s.call(i, e), null, r), s);
        }
        function r(e, t) {
          let s;
          const i = new v({ onWillAddFirstListener() {
            s = e(i.fire, i);
          }, onDidRemoveLastListener() {
            s?.dispose();
          } });
          return t?.add(i), i.event;
        }
        function o(e, t, s = 100, i = false, r = false, n, o) {
          let a, h, c, l, u = 0;
          const d = new v({ leakWarningThreshold: n, onWillAddFirstListener() {
            a = e((e) => {
              u++, h = t(h, e), i && !c && (d.fire(h), h = undefined), l = () => {
                const e = h;
                h = undefined, c = undefined, (!i || u > 1) && d.fire(e), u = 0;
              }, typeof s == "number" ? (clearTimeout(c), c = setTimeout(l, s)) : c === undefined && (c = 0, queueMicrotask(l));
            });
          }, onWillRemoveListener() {
            r && u > 0 && l?.();
          }, onDidRemoveLastListener() {
            l = undefined, a.dispose();
          } });
          return o?.add(d), d.event;
        }
        e.None = () => n.Disposable.None, e.defer = function(e, t) {
          return o(e, () => {}, 0, undefined, true, undefined, t);
        }, e.once = t, e.map = s, e.forEach = function(e, t, s) {
          return r((s, i = null, r) => e((e) => {
            t(e), s.call(i, e);
          }, null, r), s);
        }, e.filter = i, e.signal = function(e) {
          return e;
        }, e.any = function(...e) {
          return (t, s = null, i) => {
            return r = (0, n.combinedDisposable)(...e.map((e) => e((e) => t.call(s, e)))), (o = i) instanceof Array ? o.push(r) : o && o.add(r), r;
            var r, o;
          };
        }, e.reduce = function(e, t, i, r) {
          let n = i;
          return s(e, (e) => (n = t(n, e), n), r);
        }, e.debounce = o, e.accumulate = function(t, s = 0, i) {
          return e.debounce(t, (e, t) => e ? (e.push(t), e) : [t], s, undefined, true, undefined, i);
        }, e.latch = function(e, t = (e, t) => e === t, s) {
          let r, n = true;
          return i(e, (e) => {
            const s = n || !t(e, r);
            return n = false, r = e, s;
          }, s);
        }, e.split = function(t, s, i) {
          return [e.filter(t, s, i), e.filter(t, (e) => !s(e), i)];
        }, e.buffer = function(e, t = false, s = [], i) {
          let r = s.slice(), n = e((e) => {
            r ? r.push(e) : a.fire(e);
          });
          i && i.add(n);
          const o = () => {
            r?.forEach((e) => a.fire(e)), r = null;
          }, a = new v({ onWillAddFirstListener() {
            n || (n = e((e) => a.fire(e)), i && i.add(n));
          }, onDidAddFirstListener() {
            r && (t ? setTimeout(o) : o());
          }, onDidRemoveLastListener() {
            n && n.dispose(), n = null;
          } });
          return i && i.add(a), a.event;
        }, e.chain = function(e, t) {
          return (s, i, r) => {
            const n = t(new h);
            return e(function(e) {
              const t = n.evaluate(e);
              t !== a && s.call(i, t);
            }, undefined, r);
          };
        };
        const a = Symbol("HaltChainable");

        class h {
          constructor() {
            this.steps = [];
          }
          map(e) {
            return this.steps.push(e), this;
          }
          forEach(e) {
            return this.steps.push((t) => (e(t), t)), this;
          }
          filter(e) {
            return this.steps.push((t) => e(t) ? t : a), this;
          }
          reduce(e, t) {
            let s = t;
            return this.steps.push((t) => (s = e(s, t), s)), this;
          }
          latch(e = (e, t) => e === t) {
            let t, s = true;
            return this.steps.push((i) => {
              const r = s || !e(i, t);
              return s = false, t = i, r ? i : a;
            }), this;
          }
          evaluate(e) {
            for (const t of this.steps)
              if ((e = t(e)) === a)
                break;
            return e;
          }
        }
        e.fromNodeEventEmitter = function(e, t, s = (e) => e) {
          const i = (...e) => r.fire(s(...e)), r = new v({ onWillAddFirstListener: () => e.on(t, i), onDidRemoveLastListener: () => e.removeListener(t, i) });
          return r.event;
        }, e.fromDOMEventEmitter = function(e, t, s = (e) => e) {
          const i = (...e) => r.fire(s(...e)), r = new v({ onWillAddFirstListener: () => e.addEventListener(t, i), onDidRemoveLastListener: () => e.removeEventListener(t, i) });
          return r.event;
        }, e.toPromise = function(e) {
          return new Promise((s) => t(e)(s));
        }, e.fromPromise = function(e) {
          const t = new v;
          return e.then((e) => {
            t.fire(e);
          }, () => {
            t.fire(undefined);
          }).finally(() => {
            t.dispose();
          }), t.event;
        }, e.forward = function(e, t) {
          return e((e) => t.fire(e));
        }, e.runAndSubscribe = function(e, t, s) {
          return t(s), e((e) => t(e));
        };

        class c {
          constructor(e, t) {
            this._observable = e, this._counter = 0, this._hasChanged = false;
            const s = { onWillAddFirstListener: () => {
              e.addObserver(this);
            }, onDidRemoveLastListener: () => {
              e.removeObserver(this);
            } };
            this.emitter = new v(s), t && t.add(this.emitter);
          }
          beginUpdate(e) {
            this._counter++;
          }
          handlePossibleChange(e) {}
          handleChange(e, t) {
            this._hasChanged = true;
          }
          endUpdate(e) {
            this._counter--, this._counter === 0 && (this._observable.reportChanges(), this._hasChanged && (this._hasChanged = false, this.emitter.fire(this._observable.get())));
          }
        }
        e.fromObservable = function(e, t) {
          return new c(e, t).emitter.event;
        }, e.fromObservableLight = function(e) {
          return (t, s, i) => {
            let r = 0, o = false;
            const a = { beginUpdate() {
              r++;
            }, endUpdate() {
              r--, r === 0 && (e.reportChanges(), o && (o = false, t.call(s)));
            }, handlePossibleChange() {}, handleChange() {
              o = true;
            } };
            e.addObserver(a), e.reportChanges();
            const h = { dispose() {
              e.removeObserver(a);
            } };
            return i instanceof n.DisposableStore ? i.add(h) : Array.isArray(i) && i.push(h), h;
          };
        };
      })(h || (t.Event = h = {}));

      class c {
        static {
          this.all = new Set;
        }
        static {
          this._idPool = 0;
        }
        constructor(e) {
          this.listenerCount = 0, this.invocationCount = 0, this.elapsedOverall = 0, this.durations = [], this.name = `${e}_${c._idPool++}`, c.all.add(this);
        }
        start(e) {
          this._stopWatch = new a.StopWatch, this.listenerCount = e;
        }
        stop() {
          if (this._stopWatch) {
            const e = this._stopWatch.elapsed();
            this.durations.push(e), this.elapsedOverall += e, this.invocationCount += 1, this._stopWatch = undefined;
          }
        }
      }
      t.EventProfiling = c;
      let l = -1;

      class u {
        static {
          this._idPool = 1;
        }
        constructor(e, t, s = (u._idPool++).toString(16).padStart(3, "0")) {
          this._errorHandler = e, this.threshold = t, this.name = s, this._warnCountdown = 0;
        }
        dispose() {
          this._stacks?.clear();
        }
        check(e, t) {
          const s = this.threshold;
          if (s <= 0 || t < s)
            return;
          this._stacks || (this._stacks = new Map);
          const i = this._stacks.get(e.value) || 0;
          if (this._stacks.set(e.value, i + 1), this._warnCountdown -= 1, this._warnCountdown <= 0) {
            this._warnCountdown = 0.5 * s;
            const [e, i] = this.getMostFrequentStack(), r = `[${this.name}] potential listener LEAK detected, having ${t} listeners already. MOST frequent listener (${i}):`;
            console.warn(r), console.warn(e);
            const n = new f(r, e);
            this._errorHandler(n);
          }
          return () => {
            const t = this._stacks.get(e.value) || 0;
            this._stacks.set(e.value, t - 1);
          };
        }
        getMostFrequentStack() {
          if (!this._stacks)
            return;
          let e, t = 0;
          for (const [s, i] of this._stacks)
            (!e || t < i) && (e = [s, i], t = i);
          return e;
        }
      }

      class d {
        static create() {
          const e = new Error;
          return new d(e.stack ?? "");
        }
        constructor(e) {
          this.value = e;
        }
        print() {
          console.warn(this.value.split(`
`).slice(2).join(`
`));
        }
      }

      class f extends Error {
        constructor(e, t) {
          super(e), this.name = "ListenerLeakError", this.stack = t;
        }
      }
      t.ListenerLeakError = f;

      class _ extends Error {
        constructor(e, t) {
          super(e), this.name = "ListenerRefusalError", this.stack = t;
        }
      }
      t.ListenerRefusalError = _;
      let p = 0;

      class g {
        constructor(e) {
          this.value = e, this.id = p++;
        }
      }

      class v {
        constructor(e) {
          this._size = 0, this._options = e, this._leakageMon = l > 0 || this._options?.leakWarningThreshold ? new u(e?.onListenerError ?? i.onUnexpectedError, this._options?.leakWarningThreshold ?? l) : undefined, this._perfMon = this._options?._profName ? new c(this._options._profName) : undefined, this._deliveryQueue = this._options?.deliveryQueue;
        }
        dispose() {
          this._disposed || (this._disposed = true, this._deliveryQueue?.current === this && this._deliveryQueue.reset(), this._listeners && (this._listeners = undefined, this._size = 0), this._options?.onDidRemoveLastListener?.(), this._leakageMon?.dispose());
        }
        get event() {
          return this._event ??= (e, t, s) => {
            if (this._leakageMon && this._size > this._leakageMon.threshold ** 2) {
              const e = `[${this._leakageMon.name}] REFUSES to accept new listeners because it exceeded its threshold by far (${this._size} vs ${this._leakageMon.threshold})`;
              console.warn(e);
              const t = this._leakageMon.getMostFrequentStack() ?? ["UNKNOWN stack", -1], s = new _(`${e}. HINT: Stack shows most frequent listener (${t[1]}-times)`, t[0]);
              return (this._options?.onListenerError || i.onUnexpectedError)(s), n.Disposable.None;
            }
            if (this._disposed)
              return n.Disposable.None;
            t && (e = e.bind(t));
            const r = new g(e);
            let o;
            this._leakageMon && this._size >= Math.ceil(0.2 * this._leakageMon.threshold) && (r.stack = d.create(), o = this._leakageMon.check(r.stack, this._size + 1)), this._listeners ? this._listeners instanceof g ? (this._deliveryQueue ??= new m, this._listeners = [this._listeners, r]) : this._listeners.push(r) : (this._options?.onWillAddFirstListener?.(this), this._listeners = r, this._options?.onDidAddFirstListener?.(this)), this._size++;
            const a = (0, n.toDisposable)(() => {
              o?.(), this._removeListener(r);
            });
            return s instanceof n.DisposableStore ? s.add(a) : Array.isArray(s) && s.push(a), a;
          }, this._event;
        }
        _removeListener(e) {
          if (this._options?.onWillRemoveListener?.(this), !this._listeners)
            return;
          if (this._size === 1)
            return this._listeners = undefined, this._options?.onDidRemoveLastListener?.(this), void (this._size = 0);
          const t = this._listeners, s = t.indexOf(e);
          if (s === -1)
            throw console.log("disposed?", this._disposed), console.log("size?", this._size), console.log("arr?", JSON.stringify(this._listeners)), new Error("Attempted to dispose unknown listener");
          this._size--, t[s] = undefined;
          const i = this._deliveryQueue.current === this;
          if (2 * this._size <= t.length) {
            let e = 0;
            for (let s = 0;s < t.length; s++)
              t[s] ? t[e++] = t[s] : i && (this._deliveryQueue.end--, e < this._deliveryQueue.i && this._deliveryQueue.i--);
            t.length = e;
          }
        }
        _deliver(e, t) {
          if (!e)
            return;
          const s = this._options?.onListenerError || i.onUnexpectedError;
          if (s)
            try {
              e.value(t);
            } catch (e) {
              s(e);
            }
          else
            e.value(t);
        }
        _deliverQueue(e) {
          const t = e.current._listeners;
          for (;e.i < e.end; )
            this._deliver(t[e.i++], e.value);
          e.reset();
        }
        fire(e) {
          if (this._deliveryQueue?.current && (this._deliverQueue(this._deliveryQueue), this._perfMon?.stop()), this._perfMon?.start(this._size), this._listeners)
            if (this._listeners instanceof g)
              this._deliver(this._listeners, e);
            else {
              const t = this._deliveryQueue;
              t.enqueue(this, e, this._listeners.length), this._deliverQueue(t);
            }
          this._perfMon?.stop();
        }
        hasListeners() {
          return this._size > 0;
        }
      }
      t.Emitter = v, t.createEventDeliveryQueue = () => new m;

      class m {
        constructor() {
          this.i = -1, this.end = 0;
        }
        enqueue(e, t, s) {
          this.i = 0, this.end = s, this.current = e, this.value = t;
        }
        reset() {
          this.i = this.end, this.current = undefined, this.value = undefined;
        }
      }
      t.AsyncEmitter = class extends v {
        async fireAsync(e, t, s) {
          if (this._listeners)
            for (this._asyncDeliveryQueue || (this._asyncDeliveryQueue = new o.LinkedList), ((e, t) => {
              if (e instanceof g)
                t(e);
              else
                for (let s = 0;s < e.length; s++) {
                  const i = e[s];
                  i && t(i);
                }
            })(this._listeners, (t) => this._asyncDeliveryQueue.push([t.value, e]));this._asyncDeliveryQueue.size > 0 && !t.isCancellationRequested; ) {
              const [e, r] = this._asyncDeliveryQueue.shift(), n = [], o = { ...r, token: t, waitUntil: (t) => {
                if (Object.isFrozen(n))
                  throw new Error("waitUntil can NOT be called asynchronous");
                s && (t = s(t, e)), n.push(t);
              } };
              try {
                e(o);
              } catch (e) {
                (0, i.onUnexpectedError)(e);
                continue;
              }
              Object.freeze(n), await Promise.allSettled(n).then((e) => {
                for (const t of e)
                  t.status === "rejected" && (0, i.onUnexpectedError)(t.reason);
              });
            }
        }
      };

      class b extends v {
        get isPaused() {
          return this._isPaused !== 0;
        }
        constructor(e) {
          super(e), this._isPaused = 0, this._eventQueue = new o.LinkedList, this._mergeFn = e?.merge;
        }
        pause() {
          this._isPaused++;
        }
        resume() {
          if (this._isPaused !== 0 && --this._isPaused == 0)
            if (this._mergeFn) {
              if (this._eventQueue.size > 0) {
                const e = Array.from(this._eventQueue);
                this._eventQueue.clear(), super.fire(this._mergeFn(e));
              }
            } else
              for (;!this._isPaused && this._eventQueue.size !== 0; )
                super.fire(this._eventQueue.shift());
        }
        fire(e) {
          this._size && (this._isPaused !== 0 ? this._eventQueue.push(e) : super.fire(e));
        }
      }
      t.PauseableEmitter = b, t.DebounceEmitter = class extends b {
        constructor(e) {
          super(e), this._delay = e.delay ?? 100;
        }
        fire(e) {
          this._handle || (this.pause(), this._handle = setTimeout(() => {
            this._handle = undefined, this.resume();
          }, this._delay)), super.fire(e);
        }
      }, t.MicrotaskEmitter = class extends v {
        constructor(e) {
          super(e), this._queuedEvents = [], this._mergeFn = e?.merge;
        }
        fire(e) {
          this.hasListeners() && (this._queuedEvents.push(e), this._queuedEvents.length === 1 && queueMicrotask(() => {
            this._mergeFn ? super.fire(this._mergeFn(this._queuedEvents)) : this._queuedEvents.forEach((e) => super.fire(e)), this._queuedEvents = [];
          }));
        }
      };

      class S {
        constructor() {
          this.hasListeners = false, this.events = [], this.emitter = new v({ onWillAddFirstListener: () => this.onFirstListenerAdd(), onDidRemoveLastListener: () => this.onLastListenerRemove() });
        }
        get event() {
          return this.emitter.event;
        }
        add(e) {
          const t = { event: e, listener: null };
          return this.events.push(t), this.hasListeners && this.hook(t), (0, n.toDisposable)((0, r.createSingleCallFunction)(() => {
            this.hasListeners && this.unhook(t);
            const e = this.events.indexOf(t);
            this.events.splice(e, 1);
          }));
        }
        onFirstListenerAdd() {
          this.hasListeners = true, this.events.forEach((e) => this.hook(e));
        }
        onLastListenerRemove() {
          this.hasListeners = false, this.events.forEach((e) => this.unhook(e));
        }
        hook(e) {
          e.listener = e.event((e) => this.emitter.fire(e));
        }
        unhook(e) {
          e.listener?.dispose(), e.listener = null;
        }
        dispose() {
          this.emitter.dispose();
          for (const e of this.events)
            e.listener?.dispose();
          this.events = [];
        }
      }
      t.EventMultiplexer = S, t.DynamicListEventMultiplexer = class {
        constructor(e, t, s, i) {
          this._store = new n.DisposableStore;
          const r = this._store.add(new S), o = this._store.add(new n.DisposableMap);
          function a(e) {
            o.set(e, r.add(i(e)));
          }
          for (const t of e)
            a(t);
          this._store.add(t((e) => {
            a(e);
          })), this._store.add(s((e) => {
            o.deleteAndDispose(e);
          })), this.event = r.event;
        }
        dispose() {
          this._store.dispose();
        }
      }, t.EventBufferer = class {
        constructor() {
          this.data = [];
        }
        wrapEvent(e, t, s) {
          return (i, r, n) => e((e) => {
            const n = this.data[this.data.length - 1];
            if (!t)
              return void (n ? n.buffers.push(() => i.call(r, e)) : i.call(r, e));
            const o = n;
            o ? (o.items ??= [], o.items.push(e), o.buffers.length === 0 && n.buffers.push(() => {
              o.reducedResult ??= s ? o.items.reduce(t, s) : o.items.reduce(t), i.call(r, o.reducedResult);
            })) : i.call(r, t(s, e));
          }, undefined, n);
        }
        bufferEvents(e) {
          const t = { buffers: new Array };
          this.data.push(t);
          const s = e();
          return this.data.pop(), t.buffers.forEach((e) => e()), s;
        }
      }, t.Relay = class {
        constructor() {
          this.listening = false, this.inputEvent = h.None, this.inputEventListener = n.Disposable.None, this.emitter = new v({ onDidAddFirstListener: () => {
            this.listening = true, this.inputEventListener = this.inputEvent(this.emitter.fire, this.emitter);
          }, onDidRemoveLastListener: () => {
            this.listening = false, this.inputEventListener.dispose();
          } }), this.event = this.emitter.event;
        }
        set input(e) {
          this.inputEvent = e, this.listening && (this.inputEventListener.dispose(), this.inputEventListener = e(this.emitter.fire, this.emitter));
        }
        dispose() {
          this.inputEventListener.dispose(), this.emitter.dispose();
        }
      }, t.ValueWithChangeEvent = class {
        static const(e) {
          return new y(e);
        }
        constructor(e) {
          this._value = e, this._onDidChange = new v, this.onDidChange = this._onDidChange.event;
        }
        get value() {
          return this._value;
        }
        set value(e) {
          e !== this._value && (this._value = e, this._onDidChange.fire(undefined));
        }
      };

      class y {
        constructor(e) {
          this.value = e, this.onDidChange = h.None;
        }
      }
    }, 8841: (e, t) => {
      Object.defineProperty(t, "__esModule", { value: true }), t.createSingleCallFunction = function(e, t) {
        const s = this;
        let i, r = false;
        return function() {
          if (r)
            return i;
          if (r = true, t)
            try {
              i = e.apply(s, arguments);
            } finally {
              t();
            }
          else
            i = e.apply(s, arguments);
          return i;
        };
      };
    }, 4218: (e, t) => {
      var s;
      Object.defineProperty(t, "__esModule", { value: true }), t.Iterable = undefined, function(e) {
        function t(e) {
          return e && typeof e == "object" && typeof e[Symbol.iterator] == "function";
        }
        e.is = t;
        const s = Object.freeze([]);
        function* i(e) {
          yield e;
        }
        e.empty = function() {
          return s;
        }, e.single = i, e.wrap = function(e) {
          return t(e) ? e : i(e);
        }, e.from = function(e) {
          return e || s;
        }, e.reverse = function* (e) {
          for (let t = e.length - 1;t >= 0; t--)
            yield e[t];
        }, e.isEmpty = function(e) {
          return !e || e[Symbol.iterator]().next().done === true;
        }, e.first = function(e) {
          return e[Symbol.iterator]().next().value;
        }, e.some = function(e, t) {
          let s = 0;
          for (const i of e)
            if (t(i, s++))
              return true;
          return false;
        }, e.find = function(e, t) {
          for (const s of e)
            if (t(s))
              return s;
        }, e.filter = function* (e, t) {
          for (const s of e)
            t(s) && (yield s);
        }, e.map = function* (e, t) {
          let s = 0;
          for (const i of e)
            yield t(i, s++);
        }, e.flatMap = function* (e, t) {
          let s = 0;
          for (const i of e)
            yield* t(i, s++);
        }, e.concat = function* (...e) {
          for (const t of e)
            yield* t;
        }, e.reduce = function(e, t, s) {
          let i = s;
          for (const s of e)
            i = t(i, s);
          return i;
        }, e.slice = function* (e, t, s = e.length) {
          for (t < 0 && (t += e.length), s < 0 ? s += e.length : s > e.length && (s = e.length);t < s; t++)
            yield e[t];
        }, e.consume = function(t, s = Number.POSITIVE_INFINITY) {
          const i = [];
          if (s === 0)
            return [i, t];
          const r = t[Symbol.iterator]();
          for (let t = 0;t < s; t++) {
            const t = r.next();
            if (t.done)
              return [i, e.empty()];
            i.push(t.value);
          }
          return [i, { [Symbol.iterator]: () => r }];
        }, e.asyncToArray = async function(e) {
          const t = [];
          for await (const s of e)
            t.push(s);
          return Promise.resolve(t);
        };
      }(s || (t.Iterable = s = {}));
    }, 7150: (e, t, s) => {
      Object.defineProperty(t, "__esModule", { value: true }), t.DisposableMap = t.ImmortalReference = t.AsyncReferenceCollection = t.ReferenceCollection = t.SafeDisposable = t.RefCountedDisposable = t.MandatoryMutableDisposable = t.MutableDisposable = t.Disposable = t.DisposableStore = t.DisposableTracker = undefined, t.setDisposableTracker = function(e) {
        h = e;
      }, t.trackDisposable = l, t.markAsDisposed = u, t.markAsSingleton = function(e) {
        return h?.markAsSingleton(e), e;
      }, t.isDisposable = f, t.dispose = _, t.disposeIfDisposable = function(e) {
        for (const t of e)
          f(t) && t.dispose();
        return [];
      }, t.combinedDisposable = function(...e) {
        const t = p(() => _(e));
        return function(e, t) {
          if (h)
            for (const s of e)
              h.setParent(s, t);
        }(e, t), t;
      }, t.toDisposable = p, t.disposeOnReturn = function(e) {
        const t = new g;
        try {
          e(t);
        } finally {
          t.dispose();
        }
      };
      const i = s(3058), r = s(9087), n = s(2608), o = s(8841), a = s(4218);
      let h = null;

      class c {
        constructor() {
          this.livingDisposables = new Map;
        }
        static {
          this.idx = 0;
        }
        getDisposableData(e) {
          let t = this.livingDisposables.get(e);
          return t || (t = { parent: null, source: null, isSingleton: false, value: e, idx: c.idx++ }, this.livingDisposables.set(e, t)), t;
        }
        trackDisposable(e) {
          const t = this.getDisposableData(e);
          t.source || (t.source = new Error().stack);
        }
        setParent(e, t) {
          this.getDisposableData(e).parent = t;
        }
        markAsDisposed(e) {
          this.livingDisposables.delete(e);
        }
        markAsSingleton(e) {
          this.getDisposableData(e).isSingleton = true;
        }
        getRootParent(e, t) {
          const s = t.get(e);
          if (s)
            return s;
          const i = e.parent ? this.getRootParent(this.getDisposableData(e.parent), t) : e;
          return t.set(e, i), i;
        }
        getTrackedDisposables() {
          const e = new Map;
          return [...this.livingDisposables.entries()].filter(([, t]) => t.source !== null && !this.getRootParent(t, e).isSingleton).flatMap(([e]) => e);
        }
        computeLeakingDisposables(e = 10, t) {
          let s;
          if (t)
            s = t;
          else {
            const e = new Map, t = [...this.livingDisposables.values()].filter((t) => t.source !== null && !this.getRootParent(t, e).isSingleton);
            if (t.length === 0)
              return;
            const i = new Set(t.map((e) => e.value));
            if (s = t.filter((e) => !(e.parent && i.has(e.parent))), s.length === 0)
              throw new Error("There are cyclic diposable chains!");
          }
          if (!s)
            return;
          function o(e) {
            const t = e.source.split(`
`).map((e) => e.trim().replace("at ", "")).filter((e) => e !== "");
            return function(e, t) {
              for (;e.length > 0 && t.some((t) => typeof t == "string" ? t === e[0] : e[0].match(t)); )
                e.shift();
            }(t, ["Error", /^trackDisposable \(.*\)$/, /^DisposableTracker.trackDisposable \(.*\)$/]), t.reverse();
          }
          const a = new n.SetMap;
          for (const e of s) {
            const t = o(e);
            for (let s = 0;s <= t.length; s++)
              a.add(t.slice(0, s).join(`
`), e);
          }
          s.sort((0, i.compareBy)((e) => e.idx, i.numberComparator));
          let h = "", c = 0;
          for (const t of s.slice(0, e)) {
            c++;
            const e = o(t), i = [];
            for (let t = 0;t < e.length; t++) {
              let n = e[t];
              n = `(shared with ${a.get(e.slice(0, t + 1).join(`
`)).size}/${s.length} leaks) at ${n}`;
              const h = a.get(e.slice(0, t).join(`
`)), c = (0, r.groupBy)([...h].map((e) => o(e)[t]), (e) => e);
              delete c[e[t]];
              for (const [e, t] of Object.entries(c))
                i.unshift(`    - stacktraces of ${t.length} other leaks continue with ${e}`);
              i.unshift(n);
            }
            h += `


==================== Leaking disposable ${c}/${s.length}: ${t.value.constructor.name} ====================
${i.join(`
`)}
============================================================

`;
          }
          return s.length > e && (h += `


... and ${s.length - e} more leaking disposables

`), { leaks: s, details: h };
        }
      }
      function l(e) {
        return h?.trackDisposable(e), e;
      }
      function u(e) {
        h?.markAsDisposed(e);
      }
      function d(e, t) {
        h?.setParent(e, t);
      }
      function f(e) {
        return typeof e == "object" && e !== null && typeof e.dispose == "function" && e.dispose.length === 0;
      }
      function _(e) {
        if (a.Iterable.is(e)) {
          const t = [];
          for (const s of e)
            if (s)
              try {
                s.dispose();
              } catch (e) {
                t.push(e);
              }
          if (t.length === 1)
            throw t[0];
          if (t.length > 1)
            throw new AggregateError(t, "Encountered errors while disposing of store");
          return Array.isArray(e) ? [] : e;
        }
        if (e)
          return e.dispose(), e;
      }
      function p(e) {
        const t = l({ dispose: (0, o.createSingleCallFunction)(() => {
          u(t), e();
        }) });
        return t;
      }
      t.DisposableTracker = c;

      class g {
        static {
          this.DISABLE_DISPOSED_WARNING = false;
        }
        constructor() {
          this._toDispose = new Set, this._isDisposed = false, l(this);
        }
        dispose() {
          this._isDisposed || (u(this), this._isDisposed = true, this.clear());
        }
        get isDisposed() {
          return this._isDisposed;
        }
        clear() {
          if (this._toDispose.size !== 0)
            try {
              _(this._toDispose);
            } finally {
              this._toDispose.clear();
            }
        }
        add(e) {
          if (!e)
            return e;
          if (e === this)
            throw new Error("Cannot register a disposable on itself!");
          return d(e, this), this._isDisposed ? g.DISABLE_DISPOSED_WARNING || console.warn(new Error("Trying to add a disposable to a DisposableStore that has already been disposed of. The added object will be leaked!").stack) : this._toDispose.add(e), e;
        }
        delete(e) {
          if (e) {
            if (e === this)
              throw new Error("Cannot dispose a disposable on itself!");
            this._toDispose.delete(e), e.dispose();
          }
        }
        deleteAndLeak(e) {
          e && this._toDispose.has(e) && (this._toDispose.delete(e), d(e, null));
        }
      }
      t.DisposableStore = g;

      class v {
        static {
          this.None = Object.freeze({ dispose() {} });
        }
        constructor() {
          this._store = new g, l(this), d(this._store, this);
        }
        dispose() {
          u(this), this._store.dispose();
        }
        _register(e) {
          if (e === this)
            throw new Error("Cannot register a disposable on itself!");
          return this._store.add(e);
        }
      }
      t.Disposable = v;

      class m {
        constructor() {
          this._isDisposed = false, l(this);
        }
        get value() {
          return this._isDisposed ? undefined : this._value;
        }
        set value(e) {
          this._isDisposed || e === this._value || (this._value?.dispose(), e && d(e, this), this._value = e);
        }
        clear() {
          this.value = undefined;
        }
        dispose() {
          this._isDisposed = true, u(this), this._value?.dispose(), this._value = undefined;
        }
        clearAndLeak() {
          const e = this._value;
          return this._value = undefined, e && d(e, null), e;
        }
      }
      t.MutableDisposable = m, t.MandatoryMutableDisposable = class {
        constructor(e) {
          this._disposable = new m, this._isDisposed = false, this._disposable.value = e;
        }
        get value() {
          return this._disposable.value;
        }
        set value(e) {
          this._isDisposed || e === this._disposable.value || (this._disposable.value = e);
        }
        dispose() {
          this._isDisposed = true, this._disposable.dispose();
        }
      }, t.RefCountedDisposable = class {
        constructor(e) {
          this._disposable = e, this._counter = 1;
        }
        acquire() {
          return this._counter++, this;
        }
        release() {
          return --this._counter == 0 && this._disposable.dispose(), this;
        }
      }, t.SafeDisposable = class {
        constructor() {
          this.dispose = () => {}, this.unset = () => {}, this.isset = () => false, l(this);
        }
        set(e) {
          let t = e;
          return this.unset = () => t = undefined, this.isset = () => t !== undefined, this.dispose = () => {
            t && (t(), t = undefined, u(this));
          }, this;
        }
      }, t.ReferenceCollection = class {
        constructor() {
          this.references = new Map;
        }
        acquire(e, ...t) {
          let s = this.references.get(e);
          s || (s = { counter: 0, object: this.createReferencedObject(e, ...t) }, this.references.set(e, s));
          const { object: i } = s, r = (0, o.createSingleCallFunction)(() => {
            --s.counter == 0 && (this.destroyReferencedObject(e, s.object), this.references.delete(e));
          });
          return s.counter++, { object: i, dispose: r };
        }
      }, t.AsyncReferenceCollection = class {
        constructor(e) {
          this.referenceCollection = e;
        }
        async acquire(e, ...t) {
          const s = this.referenceCollection.acquire(e, ...t);
          try {
            return { object: await s.object, dispose: () => s.dispose() };
          } catch (e) {
            throw s.dispose(), e;
          }
        }
      }, t.ImmortalReference = class {
        constructor(e) {
          this.object = e;
        }
        dispose() {}
      };

      class b {
        constructor() {
          this._store = new Map, this._isDisposed = false, l(this);
        }
        dispose() {
          u(this), this._isDisposed = true, this.clearAndDisposeAll();
        }
        clearAndDisposeAll() {
          if (this._store.size)
            try {
              _(this._store.values());
            } finally {
              this._store.clear();
            }
        }
        has(e) {
          return this._store.has(e);
        }
        get size() {
          return this._store.size;
        }
        get(e) {
          return this._store.get(e);
        }
        set(e, t, s = false) {
          this._isDisposed && console.warn(new Error("Trying to add a disposable to a DisposableMap that has already been disposed of. The added object will be leaked!").stack), s || this._store.get(e)?.dispose(), this._store.set(e, t);
        }
        deleteAndDispose(e) {
          this._store.get(e)?.dispose(), this._store.delete(e);
        }
        deleteAndLeak(e) {
          const t = this._store.get(e);
          return this._store.delete(e), t;
        }
        keys() {
          return this._store.keys();
        }
        values() {
          return this._store.values();
        }
        [Symbol.iterator]() {
          return this._store[Symbol.iterator]();
        }
      }
      t.DisposableMap = b;
    }, 6317: (e, t) => {
      Object.defineProperty(t, "__esModule", { value: true }), t.LinkedList = undefined;

      class s {
        static {
          this.Undefined = new s(undefined);
        }
        constructor(e) {
          this.element = e, this.next = s.Undefined, this.prev = s.Undefined;
        }
      }

      class i {
        constructor() {
          this._first = s.Undefined, this._last = s.Undefined, this._size = 0;
        }
        get size() {
          return this._size;
        }
        isEmpty() {
          return this._first === s.Undefined;
        }
        clear() {
          let e = this._first;
          for (;e !== s.Undefined; ) {
            const t = e.next;
            e.prev = s.Undefined, e.next = s.Undefined, e = t;
          }
          this._first = s.Undefined, this._last = s.Undefined, this._size = 0;
        }
        unshift(e) {
          return this._insert(e, false);
        }
        push(e) {
          return this._insert(e, true);
        }
        _insert(e, t) {
          const i = new s(e);
          if (this._first === s.Undefined)
            this._first = i, this._last = i;
          else if (t) {
            const e = this._last;
            this._last = i, i.prev = e, e.next = i;
          } else {
            const e = this._first;
            this._first = i, i.next = e, e.prev = i;
          }
          this._size += 1;
          let r = false;
          return () => {
            r || (r = true, this._remove(i));
          };
        }
        shift() {
          if (this._first !== s.Undefined) {
            const e = this._first.element;
            return this._remove(this._first), e;
          }
        }
        pop() {
          if (this._last !== s.Undefined) {
            const e = this._last.element;
            return this._remove(this._last), e;
          }
        }
        _remove(e) {
          if (e.prev !== s.Undefined && e.next !== s.Undefined) {
            const t = e.prev;
            t.next = e.next, e.next.prev = t;
          } else
            e.prev === s.Undefined && e.next === s.Undefined ? (this._first = s.Undefined, this._last = s.Undefined) : e.next === s.Undefined ? (this._last = this._last.prev, this._last.next = s.Undefined) : e.prev === s.Undefined && (this._first = this._first.next, this._first.prev = s.Undefined);
          this._size -= 1;
        }
        *[Symbol.iterator]() {
          let e = this._first;
          for (;e !== s.Undefined; )
            yield e.element, e = e.next;
        }
      }
      t.LinkedList = i;
    }, 2608: (e, t) => {
      var s;
      Object.defineProperty(t, "__esModule", { value: true }), t.SetMap = t.BidirectionalMap = t.CounterSet = t.Touch = undefined, t.getOrSet = function(e, t, s) {
        let i = e.get(t);
        return i === undefined && (i = s, e.set(t, i)), i;
      }, t.mapToString = function(e) {
        const t = [];
        return e.forEach((e, s) => {
          t.push(`${s} => ${e}`);
        }), `Map(${e.size}) {${t.join(", ")}}`;
      }, t.setToString = function(e) {
        const t = [];
        return e.forEach((e) => {
          t.push(e);
        }), `Set(${e.size}) {${t.join(", ")}}`;
      }, t.mapsStrictEqualIgnoreOrder = function(e, t) {
        if (e === t)
          return true;
        if (e.size !== t.size)
          return false;
        for (const [s, i] of e)
          if (!t.has(s) || t.get(s) !== i)
            return false;
        for (const [s] of t)
          if (!e.has(s))
            return false;
        return true;
      }, function(e) {
        e[e.None = 0] = "None", e[e.AsOld = 1] = "AsOld", e[e.AsNew = 2] = "AsNew";
      }(s || (t.Touch = s = {})), t.CounterSet = class {
        constructor() {
          this.map = new Map;
        }
        add(e) {
          return this.map.set(e, (this.map.get(e) || 0) + 1), this;
        }
        delete(e) {
          let t = this.map.get(e) || 0;
          return t !== 0 && (t--, t === 0 ? this.map.delete(e) : this.map.set(e, t), true);
        }
        has(e) {
          return this.map.has(e);
        }
      }, t.BidirectionalMap = class {
        constructor(e) {
          if (this._m1 = new Map, this._m2 = new Map, e)
            for (const [t, s] of e)
              this.set(t, s);
        }
        clear() {
          this._m1.clear(), this._m2.clear();
        }
        set(e, t) {
          this._m1.set(e, t), this._m2.set(t, e);
        }
        get(e) {
          return this._m1.get(e);
        }
        getKey(e) {
          return this._m2.get(e);
        }
        delete(e) {
          const t = this._m1.get(e);
          return t !== undefined && (this._m1.delete(e), this._m2.delete(t), true);
        }
        forEach(e, t) {
          this._m1.forEach((s, i) => {
            e.call(t, s, i, this);
          });
        }
        keys() {
          return this._m1.keys();
        }
        values() {
          return this._m1.values();
        }
      }, t.SetMap = class {
        constructor() {
          this.map = new Map;
        }
        add(e, t) {
          let s = this.map.get(e);
          s || (s = new Set, this.map.set(e, s)), s.add(t);
        }
        delete(e, t) {
          const s = this.map.get(e);
          s && (s.delete(t), s.size === 0 && this.map.delete(e));
        }
        forEach(e, t) {
          const s = this.map.get(e);
          s && s.forEach(t);
        }
        get(e) {
          return this.map.get(e) || new Set;
        }
      };
    }, 9725: (e, t) => {
      Object.defineProperty(t, "__esModule", { value: true }), t.StopWatch = undefined;
      const s = globalThis.performance && typeof globalThis.performance.now == "function";

      class i {
        static create(e) {
          return new i(e);
        }
        constructor(e) {
          this._now = s && e === false ? Date.now : globalThis.performance.now.bind(globalThis.performance), this._startTime = this._now(), this._stopTime = -1;
        }
        stop() {
          this._stopTime = this._now();
        }
        reset() {
          this._startTime = this._now(), this._stopTime = -1;
        }
        elapsed() {
          return this._stopTime !== -1 ? this._stopTime - this._startTime : this._now() - this._startTime;
        }
      }
      t.StopWatch = i;
    } }, t = {};
    function s(i) {
      var r = t[i];
      if (r !== undefined)
        return r.exports;
      var n = t[i] = { exports: {} };
      return e[i].call(n.exports, n, n.exports, s), n.exports;
    }
    var i = {};
    (() => {
      var e = i;
      Object.defineProperty(e, "__esModule", { value: true }), e.Terminal = undefined;
      const t = s(5101), r = s(6097), n = s(4335), o = s(5856), a = s(3027), h = s(7150), c = ["cols", "rows"];

      class l extends h.Disposable {
        constructor(e) {
          super(), this._core = this._register(new o.Terminal(e)), this._addonManager = this._register(new a.AddonManager), this._publicOptions = { ...this._core.options };
          const t = (e) => this._core.options[e], s = (e, t) => {
            this._checkReadonlyOptions(e), this._core.options[e] = t;
          };
          for (const e in this._core.options) {
            Object.defineProperty(this._publicOptions, e, { get: () => this._core.options[e], set: (t) => {
              this._checkReadonlyOptions(e), this._core.options[e] = t;
            } });
            const i = { get: t.bind(this, e), set: s.bind(this, e) };
            Object.defineProperty(this._publicOptions, e, i);
          }
        }
        _checkReadonlyOptions(e) {
          if (c.includes(e))
            throw new Error(`Option "${e}" can only be set in the constructor`);
        }
        _checkProposedApi() {
          if (!this._core.optionsService.options.allowProposedApi)
            throw new Error("You must set the allowProposedApi option to true to use proposed API");
        }
        get onBell() {
          return this._core.onBell;
        }
        get onBinary() {
          return this._core.onBinary;
        }
        get onCursorMove() {
          return this._core.onCursorMove;
        }
        get onData() {
          return this._core.onData;
        }
        get onLineFeed() {
          return this._core.onLineFeed;
        }
        get onResize() {
          return this._core.onResize;
        }
        get onScroll() {
          return this._core.onScroll;
        }
        get onTitleChange() {
          return this._core.onTitleChange;
        }
        get onWriteParsed() {
          return this._core.onWriteParsed;
        }
        get parser() {
          return this._checkProposedApi(), this._parser || (this._parser = new r.ParserApi(this._core)), this._parser;
        }
        get unicode() {
          return this._checkProposedApi(), new n.UnicodeApi(this._core);
        }
        get rows() {
          return this._core.rows;
        }
        get cols() {
          return this._core.cols;
        }
        get buffer() {
          return this._checkProposedApi(), this._buffer || (this._buffer = this._register(new t.BufferNamespaceApi(this._core))), this._buffer;
        }
        get markers() {
          return this._checkProposedApi(), this._core.markers;
        }
        get modes() {
          const e = this._core.coreService.decPrivateModes;
          let t = "none";
          switch (this._core.coreMouseService.activeProtocol) {
            case "X10":
              t = "x10";
              break;
            case "VT200":
              t = "vt200";
              break;
            case "DRAG":
              t = "drag";
              break;
            case "ANY":
              t = "any";
          }
          return { applicationCursorKeysMode: e.applicationCursorKeys, applicationKeypadMode: e.applicationKeypad, bracketedPasteMode: e.bracketedPasteMode, insertMode: this._core.coreService.modes.insertMode, mouseTrackingMode: t, originMode: e.origin, reverseWraparoundMode: e.reverseWraparound, sendFocusMode: e.sendFocus, synchronizedOutputMode: e.synchronizedOutput, wraparoundMode: e.wraparound };
        }
        get options() {
          return this._publicOptions;
        }
        set options(e) {
          for (const t in e)
            this._publicOptions[t] = e[t];
        }
        input(e, t = true) {
          this._core.input(e, t);
        }
        resize(e, t) {
          this._verifyIntegers(e, t), this._core.resize(e, t);
        }
        registerMarker(e = 0) {
          return this._checkProposedApi(), this._verifyIntegers(e), this._core.addMarker(e);
        }
        addMarker(e) {
          return this.registerMarker(e);
        }
        dispose() {
          super.dispose();
        }
        scrollLines(e) {
          this._verifyIntegers(e), this._core.scrollLines(e);
        }
        scrollPages(e) {
          this._verifyIntegers(e), this._core.scrollPages(e);
        }
        scrollToTop() {
          this._core.scrollToTop();
        }
        scrollToBottom() {
          this._core.scrollToBottom();
        }
        scrollToLine(e) {
          this._verifyIntegers(e), this._core.scrollToLine(e);
        }
        clear() {
          this._core.clear();
        }
        write(e, t) {
          this._core.write(e, t);
        }
        writeln(e, t) {
          this._core.write(e), this._core.write(`\r
`, t);
        }
        reset() {
          this._core.reset();
        }
        loadAddon(e) {
          this._addonManager.loadAddon(this, e);
        }
        _verifyIntegers(...e) {
          for (const t of e)
            if (t === 1 / 0 || isNaN(t) || t % 1 != 0)
              throw new Error("This API only accepts integers");
        }
      }
      e.Terminal = l;
    })();
    var r = exports;
    for (var n in i)
      r[n] = i[n];
    i.__esModule && Object.defineProperty(r, "__esModule", { value: true });
  })();
});

// src/tui/plugin.tsx
import { createComponent as _$createComponent4 } from "@opentui/solid";

// src/tui/dashboard.tsx
import { use as _$use } from "@opentui/solid";
import { effect as _$effect } from "@opentui/solid";
import { createComponent as _$createComponent } from "@opentui/solid";
import { spread as _$spread } from "@opentui/solid";
import { mergeProps as _$mergeProps } from "@opentui/solid";
import { memo as _$memo } from "@opentui/solid";
import { insert as _$insert } from "@opentui/solid";
import { createTextNode as _$createTextNode } from "@opentui/solid";
import { insertNode as _$insertNode } from "@opentui/solid";
import { setProp as _$setProp } from "@opentui/solid";
import { createElement as _$createElement } from "@opentui/solid";
import { createSignal, For, Show, onCleanup, onMount, createEffect } from "solid-js";
import { useKeyboard } from "@opentui/solid";

// src/infrastructure/control-client.ts
import { randomUUID } from "crypto";

// src/infrastructure/state-repository.ts
import { promises as fs } from "fs";
import path from "path";
var CURRENT_VERSION = 9;
function emptyState() {
  return { version: CURRENT_VERSION, revision: 0, goals: [], runtimes: [], commandLedger: [], commands: [] };
}
function loopDir(directory) {
  return path.join(directory, ".opencode", "loopd");
}
function stateFile(directory) {
  return path.join(loopDir(directory), "state.json");
}
function eventsFile(directory) {
  return path.join(loopDir(directory), "events.ndjson");
}
async function readState(directory) {
  const target = stateFile(directory);
  const attempts = 5;
  for (let attempt = 0;attempt < attempts; attempt++) {
    try {
      const raw = await fs.readFile(target, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && Array.isArray(parsed.goals)) {
        return migrate(parsed);
      }
      return emptyState();
    } catch (error) {
      if (error?.code === "ENOENT")
        return emptyState();
      const transient = error instanceof SyntaxError || error?.code === "EPERM" || error?.code === "EACCES" || error?.code === "EBUSY";
      if (!transient || attempt === attempts - 1)
        break;
      await delay(25 * (attempt + 1));
    }
  }
  return emptyState();
}
function migrate(state) {
  if (state.version === CURRENT_VERSION)
    return state;
  let result = { ...state };
  if (result.version < 2) {
    result.version = 2;
    if (!result.commandLedger)
      result.commandLedger = [];
    result.runtimes = result.runtimes.map((rt) => ({
      ...rt,
      progressDuringTurn: rt.progressDuringTurn ?? false
    }));
    result.goals = result.goals.map((g) => ({
      ...g,
      lastProgress: g.lastProgress ?? undefined,
      completionEvidence: g.completionEvidence ?? undefined,
      blocker: g.blocker ?? undefined
    }));
  }
  if (result.version < 3) {
    result.version = 3;
    result.runtimes = result.runtimes.map((rt) => {
      const oldTurnCount = rt.turnCount ?? 0;
      const { turnCount: _deprecatedTurnCount, ...rest } = rt;
      return {
        ...rest,
        budgetTurnCount: rest.budgetTurnCount ?? oldTurnCount,
        runCount: rest.runCount ?? oldTurnCount,
        runGeneration: rest.runGeneration ?? 0,
        freeRetryPending: rest.freeRetryPending ?? false,
        lastRejectionDetails: rest.lastRejectionDetails ?? undefined,
        activePromptMessageID: rest.activePromptMessageID ?? undefined,
        lastActivityAt: rest.lastActivityAt ?? undefined,
        idleCandidateAt: rest.idleCandidateAt ?? undefined,
        activeToolCallIDs: rest.activeToolCallIDs ?? []
      };
    });
  }
  if (result.version < 4) {
    result.version = 4;
    result.runtimes = result.runtimes.map((rt) => ({
      ...rt,
      lastVerificationAttempt: rt.lastVerificationAttempt ?? undefined,
      recentVerificationAttempts: rt.recentVerificationAttempts ?? []
    }));
  }
  if (result.version < 5) {
    result.version = 5;
    result.goals = result.goals.map((goal) => ({
      ...goal,
      config: {
        ...goal.config,
        workspaceWrite: goal.config?.workspaceWrite ?? true
      }
    }));
    result.runtimes = result.runtimes.map((rt) => ({
      ...rt,
      activePromptObservedAt: rt.activePromptObservedAt ?? undefined,
      activeAssistantMessageID: rt.activeAssistantMessageID ?? undefined,
      activeAssistantCompletedAt: rt.activeAssistantCompletedAt ?? undefined,
      idleCandidateGeneration: rt.idleCandidateGeneration ?? undefined,
      unknownStatusCount: rt.unknownStatusCount ?? 0,
      lastUnknownStatusAt: rt.lastUnknownStatusAt ?? undefined,
      workerUnreachableNotifiedAt: rt.workerUnreachableNotifiedAt ?? undefined
    }));
  }
  if (result.version < 6) {
    result.version = 6;
    result.goals = result.goals.map((goal) => ({
      ...goal,
      config: {
        ...goal.config,
        schedule: goal.config?.schedule ?? undefined
      }
    }));
    result.goals = result.goals.map((goal) => {
      const s = goal.config?.schedule;
      if (s && typeof s.everyMs === "number" && s.everyMs >= 1000)
        return goal;
      if (s) {
        const { schedule: _s, ...restConfig } = goal.config;
        return { ...goal, config: restConfig };
      }
      return goal;
    });
    result.runtimes = result.runtimes.map((rt) => ({
      ...rt,
      scheduleRunCount: typeof rt.scheduleRunCount === "number" ? rt.scheduleRunCount : 0,
      nextRunAt: rt.nextRunAt ?? undefined,
      lastScheduleAt: rt.lastScheduleAt ?? undefined
    }));
  }
  if (result.version < 7) {
    result.version = 7;
    if (!Array.isArray(result.commands))
      result.commands = [];
  }
  if (result.version < 8) {
    result.version = 8;
    if (!Array.isArray(result.commandAwaits))
      result.commandAwaits = [];
  }
  if (result.version < 9) {
    result.version = 9;
    result.goals = result.goals.map((goal) => ({
      ...goal,
      workerTopology: goal.workerTopology ?? undefined,
      nativeParentID: goal.nativeParentID ?? undefined
    }));
  }
  return result;
}
async function writeAtomic(target, contents) {
  const dir = path.dirname(target);
  await fs.mkdir(dir, { recursive: true });
  const temp = path.join(dir, `.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await fs.writeFile(temp, contents, "utf8");
  try {
    for (let attempt = 0;attempt < 5; attempt++) {
      try {
        await fs.rename(temp, target);
        return;
      } catch (error) {
        if (error?.code === "EXDEV")
          break;
        if (error?.code !== "EPERM" && error?.code !== "EACCES" && error?.code !== "EBUSY" && error?.code !== "EEXIST" && error?.code !== "EAGAIN")
          throw error;
        if (attempt < 4)
          await delay(25 * (attempt + 1));
      }
    }
    await fs.copyFile(temp, target);
  } finally {
    try {
      await fs.rm(temp, { force: true });
    } catch {}
  }
}
async function readEvents(directory, limit = 50) {
  try {
    const raw = await fs.readFile(eventsFile(directory), "utf8");
    const lines = raw.trim().split(`
`).filter(Boolean);
    return lines.slice(-limit).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}
function controlDir(directory) {
  return path.join(loopDir(directory), "control");
}
function requestFile(directory, requestID) {
  return path.join(controlDir(directory), "requests", `${requestID}.json`);
}
function responseFile(directory, requestID) {
  return path.join(controlDir(directory), "responses", `${requestID}.json`);
}
async function writeControlRequest(directory, request) {
  const dir = path.join(controlDir(directory), "requests");
  await fs.mkdir(dir, { recursive: true });
  await writeAtomic(requestFile(directory, request.requestID), JSON.stringify(request, null, 2));
}
async function readControlResponse(directory, requestID) {
  try {
    const raw = await fs.readFile(responseFile(directory, requestID), "utf8");
    return JSON.parse(raw);
  } catch {
    return;
  }
}
function commandLogFile(directory, commandID) {
  return path.join(loopDir(directory), "commands", `${commandID}.log`);
}
async function readCommandLog(directory, commandID, opts) {
  const file = commandLogFile(directory, commandID);
  try {
    const stat = await fs.stat(file);
    const totalBytes = stat.size;
    const requestedStart = Math.max(0, opts?.offsetBytes ?? 0);
    if (requestedStart >= totalBytes)
      return { text: "", totalBytes, startByte: requestedStart };
    const fh = await fs.open(file, "r");
    try {
      const want = Math.min(opts?.limitBytes ?? 64 * 1024, totalBytes - requestedStart);
      const buf = Buffer.alloc(want);
      await fh.read(buf, 0, want, requestedStart);
      const { text, startByte, endByte } = decodeUtf8Window(buf, requestedStart);
      return { text, totalBytes, startByte };
    } finally {
      await fh.close();
    }
  } catch {
    return { text: "", totalBytes: 0, startByte: 0 };
  }
}
function decodeUtf8Window(buf, windowStart) {
  let start = 0;
  while (start < buf.length && (buf[start] & 192) === 128 && start < 4)
    start++;
  let end = buf.length;
  let leadIndex = end;
  while (leadIndex > start && (buf[leadIndex - 1] & 192) === 128)
    leadIndex--;
  if (leadIndex > start) {
    const lead = buf[leadIndex - 1];
    let expected = 1;
    if ((lead & 128) === 0)
      expected = 1;
    else if ((lead & 224) === 192)
      expected = 2;
    else if ((lead & 240) === 224)
      expected = 3;
    else if ((lead & 248) === 240)
      expected = 4;
    if (end - (leadIndex - 1) < expected)
      end = leadIndex - 1;
  } else if (leadIndex === start && start > 0 && end > start) {
    end = start;
  }
  const slice = buf.subarray(start, end);
  return { text: slice.toString("utf8"), startByte: windowStart + start, endByte: windowStart + end };
}
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// src/infrastructure/control-client.ts
function createControlClient(directory) {
  async function execute(command, timeoutMs = 30000) {
    return executeRaw({
      command: command.command,
      goalID: command.goalID,
      args: "args" in command ? command.args : undefined
    }, timeoutMs);
  }
  async function executeRaw(command, timeoutMs = 30000) {
    const request = {
      requestID: randomUUID(),
      command: command.command,
      goalID: command.goalID,
      args: command.args,
      requestedAt: new Date().toISOString()
    };
    await writeControlRequest(directory, request);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const response = await readControlResponse(directory, request.requestID);
      if (response)
        return response;
      await delay2(100);
    }
    return {
      requestID: request.requestID,
      ok: false,
      message: "timeout waiting for response",
      errorCode: "timeout",
      completedAt: new Date().toISOString()
    };
  }
  async function getState() {
    return readState(directory);
  }
  async function getEvents(limit) {
    return readEvents(directory, limit);
  }
  return { execute, executeRaw, getState, getEvents };
}
function delay2(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// src/tui/command-parser.ts
function parseCommand(input) {
  const trimmed = input.trim();
  if (!trimmed)
    return null;
  const tokens = tokenize(trimmed);
  if (tokens.length === 0)
    return null;
  const command = tokens[0];
  const args = {};
  const positional = [];
  for (let i = 1;i < tokens.length; i++) {
    const token = tokens[i];
    if (token.startsWith("--")) {
      const eqIdx = token.indexOf("=");
      if (eqIdx > 0) {
        args[token.slice(2, eqIdx)] = token.slice(eqIdx + 1);
      } else if (i + 1 < tokens.length && !tokens[i + 1].startsWith("--")) {
        args[token.slice(2)] = tokens[++i];
      } else {
        args[token.slice(2)] = "true";
      }
    } else {
      positional.push(token);
    }
  }
  return { command, args, positional, raw: trimmed };
}
function tokenize(input) {
  const tokens = [];
  let current = "";
  let inQuote = null;
  let escape = false;
  for (const char of input) {
    if (escape) {
      current += char;
      escape = false;
      continue;
    }
    if (char === "\\") {
      escape = true;
      continue;
    }
    if (inQuote) {
      if (char === inQuote) {
        inQuote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      inQuote = char;
      continue;
    }
    if (char === " " || char === "\t") {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (current)
    tokens.push(current);
  return tokens;
}
function commandHelp() {
  return [
    "Modes: : insert \u2192 send/commands | Ctrl+N \u2192 normal | ? toggle help | Shift+B bug report",
    "Nav: j/k move | g/G top/bottom | o open child | c toggle done | p/r/R/x pause/resume/retry/clear | A abort worker | N nudge | L logs | q close",
    "Goal (ownership): Active=loopd owns it | Blocked/Paused=needs you | Out of budget=resume to spend | Waiting for capacity=auto-resumes | Done=verified",
    "Worker (activity now): Running=acting now | Idle=between turns | Retrying=backing off | Queued/Compacting/Stopping=transitional",
    "Commands (insert mode, : prefix):",
    "  :send <message>                           Send bare words now as their own turn (no steering)",
    "  :open                                     Open child session (same as o)",
    "  :force <summary> --evidence <text>        Force-complete (bypass checks)",
    "  :block <reason> --needed <text>           Force-block the selected goal",
    "  :pause / :resume / :retry / :clear        Quick controls (also p/r/R/x)",
    "  :abort                                   Abort worker session now (status unchanged; A)",
    "  :nudge                                   Force re-prompt now with full steering (N)",
    "  :bug / :report                            Open prefilled GitHub bug report",
    "  :logs / :help / :q                        Toggle logs / help / close",
    "  Tip: create goals via /goal in the parent chat (agent clarifies first)."
  ].join(`
`);
}

// src/tui/command-controller.ts
function emptyCommandPanelState() {
  return { commands: [], selected: 0, selectedCommand: null, outputOffset: 0, statusText: "", inputMode: false };
}
function refreshCommandList(state, commands) {
  const prevID = state.selectedCommand?.id;
  let selected = 0;
  if (prevID) {
    const idx = commands.findIndex((c) => c.id === prevID);
    if (idx >= 0)
      selected = idx;
    else
      selected = Math.min(state.selected, Math.max(0, commands.length - 1));
  }
  return { ...state, commands, selected, selectedCommand: commands[selected] ?? null, outputOffset: 0 };
}
function moveCommandSelection(state, delta) {
  if (state.commands.length === 0)
    return state;
  const next = Math.min(Math.max(0, state.selected + delta), state.commands.length - 1);
  return { ...state, selected: next, selectedCommand: state.commands[next] ?? null, outputOffset: 0 };
}
function selectCommandFirst(state) {
  if (state.commands.length === 0)
    return state;
  return { ...state, selected: 0, selectedCommand: state.commands[0] ?? null, outputOffset: 0 };
}
function selectCommandLast(state) {
  if (state.commands.length === 0)
    return state;
  const last = state.commands.length - 1;
  return { ...state, selected: last, selectedCommand: state.commands[last] ?? null, outputOffset: 0 };
}
function parseCommandLine(input) {
  const args = [];
  let current = "";
  let quote;
  let escaped = false;
  let started = false;
  for (const char of input.trim()) {
    if (escaped) {
      current += char;
      escaped = false;
      started = true;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      started = true;
      continue;
    }
    if (quote) {
      if (char === quote)
        quote = undefined;
      else
        current += char;
      started = true;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (started) {
        args.push(current);
        current = "";
        started = false;
      }
      continue;
    }
    current += char;
    started = true;
  }
  if (quote || escaped)
    return;
  if (started)
    args.push(current);
  return args;
}
function parseNewCommandTail(raw) {
  const match = /^(?::?\s*new)(?:\s+(.*))?\s*$/s.exec(raw.trim());
  if (!match)
    return;
  const tail = (match[1] ?? "").trim();
  if (!tail)
    return;
  return parseCommandLine(tail);
}
function parseNewCommand(raw) {
  const parts = parseNewCommandTail(raw);
  if (!parts || parts.length === 0)
    return;
  const [command, ...cmdArgs] = parts;
  return { command, cmdArgs };
}

// src/domain/status-labels.ts
var GOAL_STATUS_META = {
  active: { short: "Active", hint: "loopd owns it" },
  paused: { short: "Paused", hint: "stopped by you" },
  blocked: { short: "Blocked", hint: "needs you" },
  budget_limited: { short: "Out of budget", hint: "resume to spend" },
  usage_limited: { short: "Waiting for capacity", hint: "auto-resumes" },
  complete: { short: "Done", hint: "verified" }
};
var PHASE_META = {
  idle: { short: "Idle", hint: "between turns" },
  queued: { short: "Queued", hint: "waiting to start" },
  running: { short: "Running", hint: "worker acting now" },
  compacting: { short: "Compacting", hint: "summarizing context" },
  waiting_retry: { short: "Retrying", hint: "backing off" },
  stopping: { short: "Stopping", hint: "abort in flight" }
};
function goalStatusLabel(status) {
  return GOAL_STATUS_META[status] ?? { short: status, hint: "" };
}
function phaseLabel(phase) {
  return PHASE_META[phase] ?? { short: phase, hint: "" };
}
function describeGoalState(status, phase) {
  const goal = goalStatusLabel(status);
  const activity = phase ? phaseLabel(phase) : undefined;
  const workerClause = activity ? `worker is ${activity.hint || activity.short.toLowerCase()}` : "worker state unknown";
  if (status === "active")
    return `Loopd owns this; ${workerClause}.`;
  if (status === "complete")
    return "Done \u2014 verified; worker is stopped.";
  return `Parked \u2014 ${goal.hint || goal.short.toLowerCase()}; ${workerClause}.`;
}

// src/browser.ts
import { spawn } from "child_process";
var LOOPD_ISSUES_URL = "https://github.com/bojackduy/opencode-loopd/issues/new";
function bugReportUrl(context = {}) {
  const url = new URL(LOOPD_ISSUES_URL);
  url.searchParams.set("title", "bug: ");
  url.searchParams.set("body", [
    "## What happened?",
    "",
    "Describe the unexpected behavior.",
    "",
    "## What did you expect?",
    "",
    "Describe the expected behavior.",
    "",
    "## Steps to reproduce",
    "",
    "1. ",
    "2. ",
    "3. ",
    "",
    "## Environment",
    "",
    `- opencode-loopd version: ${context.runtimeLabel ?? ""}`,
    `- OS: ${process.platform}`,
    "- Terminal:",
    "- Installation: npm / source",
    context.extra ? `
## Goal context

${context.extra}
` : "",
    "Do not include secrets, API tokens, or .opencode/loopd contents."
  ].join(`
`));
  return url.toString();
}
function openBrowserUrl(value, options = {}) {
  try {
    const url = normalizeBrowserUrl(value);
    const command = browserCommandForUrl(url, options.platform);
    const launch = options.launch ?? launchBrowserCommand;
    launch(command.command, command.args);
    return { status: "opened", url };
  } catch (error) {
    return { status: "blocked", reason: error instanceof Error ? error.message : "Could not open the browser." };
  }
}
function browserCommandForUrl(value, platform = process.platform) {
  const url = normalizeBrowserUrl(value);
  if (platform === "darwin")
    return { command: "open", args: [url] };
  if (platform === "linux")
    return { command: "xdg-open", args: [url] };
  if (platform === "win32")
    return { command: "cmd.exe", args: ["/d", "/s", "/c", `start "" "${url}"`] };
  throw new Error(`Opening a browser is not supported on ${platform}.`);
}
function normalizeBrowserUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("The selected page does not have a valid browser URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new Error("Only http and https page URLs can be opened in a browser.");
  return url.toString();
}
function launchBrowserCommand(command, args) {
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.unref();
}

// src/tui/terminal-route.ts
var TERMINAL_ROUTE_NAME = "opencode.loopd.terminal";
function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}
function validateTerminalRouteData(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, reason: "route-data-missing" };
  }
  const r = raw;
  if (!isNonEmptyString(r["commandID"]))
    return { ok: false, reason: "commandID-required" };
  if (!isNonEmptyString(r["ownerSessionID"]))
    return { ok: false, reason: "ownerSessionID-required" };
  if (!isNonEmptyString(r["returnSessionID"]))
    return { ok: false, reason: "returnSessionID-required" };
  return {
    ok: true,
    data: {
      commandID: r["commandID"],
      ownerSessionID: r["ownerSessionID"],
      returnSessionID: r["returnSessionID"]
    }
  };
}
function terminalRoutePayload(commandID, ownerSessionID, returnSessionID) {
  return { commandID, ownerSessionID, returnSessionID };
}
function isTerminalRouteConsistent(data) {
  return data.ownerSessionID === data.returnSessionID;
}
function currentRouteSessionID(api) {
  try {
    const current = api.route?.current;
    if (current?.name === "session" && current.params?.sessionID)
      return current.params.sessionID;
  } catch {}
  return;
}
function filterCommandsByOwner(commands, ownerSessionID) {
  if (!ownerSessionID)
    return [];
  return commands.filter((c) => c.ownerSessionID === ownerSessionID);
}
function resolveOpenTarget(input) {
  const sel = input.selection;
  if (!sel)
    return { kind: "none", reason: "no-selection" };
  if (sel.kind === "goal") {
    if (!sel.workerSessionID)
      return { kind: "none", reason: "no-worker-session" };
    return { kind: "goal", workerSessionID: sel.workerSessionID };
  }
  if (!sel.commandID)
    return { kind: "none", reason: "no-command" };
  if (!input.ownerSessionID)
    return { kind: "none", reason: "owner-required" };
  if (!input.returnSessionID)
    return { kind: "none", reason: "return-required" };
  return {
    kind: "command",
    data: {
      commandID: sel.commandID,
      ownerSessionID: input.ownerSessionID,
      returnSessionID: input.returnSessionID
    }
  };
}

// src/tui/dashboard-view.ts
function toggleDashboardView(view) {
  return view === "goals" ? "commands" : "goals";
}
function dashboardViewForKey(key) {
  if (key === "h")
    return "goals";
  if (key === "l")
    return "commands";
  return;
}
function moveDashboardSelection(sel, move, goalCount, commandCount) {
  if (sel.view === "goals") {
    const max = Math.max(0, goalCount - 1);
    const cur = Math.min(sel.goalIndex, max);
    switch (move) {
      case "down":
        return { ...sel, goalIndex: Math.min(max, cur + 1) };
      case "up":
        return { ...sel, goalIndex: Math.max(0, cur - 1) };
      case "first":
        return { ...sel, goalIndex: 0 };
      case "last":
        return { ...sel, goalIndex: max };
    }
  }
  const max = Math.max(0, commandCount - 1);
  const cur = Math.min(sel.commandIndex, max);
  switch (move) {
    case "down":
      return { ...sel, commandIndex: Math.min(max, cur + 1) };
    case "up":
      return { ...sel, commandIndex: Math.max(0, cur - 1) };
    case "first":
      return { ...sel, commandIndex: 0 };
    case "last":
      return { ...sel, commandIndex: max };
  }
}
function resolveDashboardOpen(lists, sel, ownerSessionID, returnSessionID) {
  if (sel.view === "goals") {
    const goal = lists.goals[sel.goalIndex];
    return resolveOpenTarget({ selection: goal ? { kind: "goal", workerSessionID: goal.workerSessionID } : null, ownerSessionID, returnSessionID });
  }
  const ownerCommands = filterCommandsByOwner(lists.commands, ownerSessionID);
  const cmd = ownerCommands[sel.commandIndex];
  return resolveOpenTarget({
    selection: cmd ? { kind: "command", commandID: cmd.id } : null,
    ownerSessionID,
    returnSessionID
  });
}
function visibleOwnerCommands(commands, ownerSessionID) {
  return filterCommandsByOwner(commands ?? [], ownerSessionID);
}

// src/tui/dashboard.tsx
import { randomUUID as randomUUID2 } from "crypto";
var LOG_FILE = "/tmp/loopd-tui.log";
function debugLog(...args) {
  try {
    const {
      appendFileSync
    } = __require("fs");
    appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${args.map((a) => typeof a === "string" ? a : JSON.stringify(a)).join(" ")}
`);
  } catch {}
}
function prevent(evt) {
  const e = evt;
  e.preventDefault?.();
  e.stopPropagation?.();
}
function keyName(evt) {
  return (evt.name || "").toLowerCase();
}
function keySeq(evt) {
  const e = evt;
  return e.sequence || e.raw || "";
}
function isEnterKey(evt) {
  const name = keyName(evt);
  if (name === "return" || name === "enter" || name === "kp_enter")
    return true;
  const seq = keySeq(evt);
  return seq === "\r" || seq === `
`;
}
function isEscapeKey(evt) {
  if (keyName(evt) === "escape" || keyName(evt) === "esc")
    return true;
  return keySeq(evt) === "\x1B";
}
function isCtrlN(evt) {
  return Boolean(evt.ctrl) && keyName(evt) === "n";
}
function statusColor(status, theme) {
  switch (status) {
    case "active":
      return theme.success;
    case "paused":
      return theme.warning;
    case "blocked":
      return theme.error;
    case "complete":
      return theme.info;
    case "budget_limited":
      return theme.accent;
    case "usage_limited":
      return theme.accent;
    default:
      return theme.text;
  }
}
function phaseColor(phase, theme) {
  switch (phase) {
    case "running":
      return theme.success;
    case "compacting":
      return theme.warning;
    case "waiting_retry":
      return theme.accent;
    case "stopping":
      return theme.error;
    default:
      return theme.textMuted;
  }
}
function borderColorForStatus(status, theme) {
  switch (status) {
    case "active":
      return theme.success;
    case "paused":
      return theme.warning;
    case "blocked":
      return theme.error;
    case "budget_limited":
    case "usage_limited":
      return theme.accent;
    default:
      return "gray";
  }
}
function eventColor(type, theme) {
  if (type === "goal.completed")
    return theme.info;
  if (type === "goal.blocked" || type === "run.failed")
    return theme.error;
  if (type === "goal.created" || type === "goal.progress")
    return theme.success;
  if (type === "run.started" || type === "compaction.started")
    return theme.warning;
  return theme.textMuted;
}
function phaseIcon(phase) {
  switch (phase) {
    case "running":
      return "\u25B6";
    case "compacting":
      return "\u23F3";
    case "waiting_retry":
      return "\uD83D\uDD04";
    case "stopping":
      return "\u23F9";
    case "queued":
      return "\u25F7";
    case "idle":
      return "\u25CB";
    default:
      return "\u25CB";
  }
}
function statusIcon(status) {
  switch (status) {
    case "active":
      return "\u25CF";
    case "paused":
      return "\u275A\u275A";
    case "blocked":
      return "\u2716";
    case "complete":
      return "\u2713";
    case "budget_limited":
      return "\u2B22";
    case "usage_limited":
      return "\u23F0";
    default:
      return "\u25CB";
  }
}
function commandStatusColor(status, theme) {
  switch (status) {
    case "running":
      return theme.success;
    case "exited":
      return theme.info;
    case "terminated":
      return theme.warning;
    case "missing":
      return theme.error;
    default:
      return theme.text;
  }
}
function commandStatusIcon(status) {
  switch (status) {
    case "running":
      return "\u25B6";
    case "exited":
      return "\u2713";
    case "terminated":
      return "\u25A0";
    case "missing":
      return "?";
    default:
      return "\u25CB";
  }
}
function commandStatusLabel(status) {
  switch (status) {
    case "running":
      return {
        short: "RUNNING",
        hint: "process is executing"
      };
    case "exited":
      return {
        short: "EXITED",
        hint: "process ended on its own"
      };
    case "terminated":
      return {
        short: "TERMINATED",
        hint: "stopped via interrupt/terminate"
      };
    case "missing":
      return {
        short: "MISSING",
        hint: "no live execution found \u2014 reconcile"
      };
    default:
      return {
        short: String(status).toUpperCase(),
        hint: ""
      };
  }
}
function commandBorderColor(status, theme) {
  return commandStatusColor(status, theme);
}
function ageLabel(timestamp, now) {
  if (!timestamp)
    return "never";
  const seconds = Math.max(0, Math.floor((now - Date.parse(timestamp)) / 1000));
  if (seconds < 60)
    return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60)
    return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}
function countdownLabel(targetIso, now) {
  if (!targetIso)
    return;
  const diff = Math.max(0, Math.floor((Date.parse(targetIso) - now) / 1000));
  if (diff < 60)
    return `${diff}s`;
  const minutes = Math.floor(diff / 60);
  if (minutes < 60)
    return `${minutes}m ${diff % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
function formatTokens(n) {
  if (!n)
    return "0";
  if (n < 1000)
    return String(Math.round(n));
  if (n < 1e6)
    return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1e6).toFixed(2)}M`;
}
function formatCost(c) {
  if (!c)
    return "$0.00";
  if (c < 0.01)
    return `$${c.toFixed(4)}`;
  return `$${c.toFixed(2)}`;
}
function formatDuration(seconds) {
  if (!seconds || seconds <= 0)
    return "0s";
  if (seconds < 60)
    return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60)
    return `${minutes}m`;
  return `${(seconds / 3600).toFixed(1)}h`;
}
function agentColor(color, theme) {
  if (!color)
    return theme.text;
  const named = {
    primary: theme.primary,
    secondary: theme.secondary,
    accent: theme.accent,
    success: theme.success,
    warning: theme.warning,
    error: theme.error,
    info: theme.info
  };
  if (named[color])
    return named[color];
  if (/^#[0-9a-fA-F]{3,8}$/.test(color))
    return color;
  return theme.text;
}
function indexAgents(list) {
  const map = {};
  for (const a of list) {
    if (!a?.name)
      continue;
    map[a.name] = {
      color: a.color,
      mode: a.mode
    };
    map[a.name.toLowerCase()] = {
      color: a.color,
      mode: a.mode
    };
  }
  return map;
}
function LoopDashboard(props) {
  const theme = () => props.api.theme.current;
  const [mode, setMode] = createSignal("normal");
  const [selected, setSelected] = createSignal(0);
  const [commandInput, setCommandInput] = createSignal("");
  const [statusText, setStatusText] = createSignal("Tab goals/commands \xB7 : send/command \xB7 ? help \xB7 c toggle done \xB7 o open \xB7 q close");
  const [tab, setTab] = createSignal(props.initialView ?? "goals");
  const [cmdSelected, setCmdSelected] = createSignal(0);
  const ownerSessionID = () => props.ownerSessionID ?? currentRouteSessionID(props.api);
  const ownerCommands = () => visibleOwnerCommands(state()?.commands, ownerSessionID());
  const [state, setState] = createSignal(null);
  const [events, setEvents] = createSignal([]);
  const [selectedGoal, setSelectedGoal] = createSignal(null);
  const [showLogs, setShowLogs] = createSignal(false);
  const [showHelp, setShowHelp] = createSignal(false);
  const [showCompleted, setShowCompleted] = createSignal(false);
  const [clock, setClock] = createSignal(Date.now());
  const [agentIndex, setAgentIndex] = createSignal({});
  let inputEl;
  let listScrollRef;
  let focusTimer;
  const client = createControlClient(props.directory);
  const popMode = props.api.mode.push("loopd.dashboard");
  function focusInput() {
    if (focusTimer)
      clearTimeout(focusTimer);
    focusTimer = setTimeout(() => {
      const current = props.api.renderer.currentFocusedRenderable;
      if (current && current !== inputEl)
        current.blur();
      inputEl?.focus();
    }, 10);
  }
  async function refresh() {
    try {
      const s = await client.getState();
      setState(s);
      const goals = s.goals.filter((g) => showCompleted() || g.status !== "complete");
      if (goals.length > 0 && selected() >= goals.length)
        setSelected(goals.length - 1);
      setSelectedGoal(goals[selected()] || null);
      const cmds = visibleOwnerCommands(s.commands, ownerSessionID());
      if (cmds.length > 0 && cmdSelected() >= cmds.length)
        setCmdSelected(cmds.length - 1);
      setEvents(await client.getEvents(20));
    } catch (e) {
      setStatusText(`Error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  refresh();
  async function refreshAgents() {
    try {
      const res = await props.api.client?.app?.agents?.();
      const list = res?.data ?? res ?? [];
      if (Array.isArray(list))
        setAgentIndex(indexAgents(list));
    } catch {}
  }
  refreshAgents();
  const unsubs = [props.api.event.on("session.idle", () => refresh()), props.api.event.on("session.status", () => refresh()), props.api.event.on("session.error", () => refresh()), props.api.event.on("session.compacted", () => refresh()), setInterval(refresh, 1e4), setInterval(() => setClock(Date.now()), 500)];
  onCleanup(() => {
    popMode();
    if (focusTimer)
      clearTimeout(focusTimer);
    for (const u of unsubs)
      typeof u === "function" ? u() : clearInterval(u);
  });
  onMount(() => {
    try {
      const {
        appendFileSync
      } = __require("fs");
      appendFileSync(LOG_FILE, `[${new Date().toISOString()}] dashboard mounted dir=${props.directory} mode=${mode()} dialogOpen=${props.api.ui.dialog.open}
`);
    } catch {}
    debugLog("mounted", "dialogOpen", props.api.ui.dialog.open, "directory", props.directory);
    focusInput();
  });
  createEffect(() => {
    const m = mode();
    debugLog("mode ->", m);
    focusInput();
  });
  function enterInsertMode() {
    setCommandInput("");
    if (inputEl)
      inputEl.value = "";
    setMode("insert");
    focusInput();
  }
  function returnToNormalMode() {
    setCommandInput("");
    if (inputEl)
      inputEl.value = "";
    setMode("normal");
    focusInput();
  }
  useKeyboard((evt) => {
    const name = evt.name || "";
    const seq = evt.sequence || "";
    const raw = evt.raw || "";
    debugLog("useKeyboard", `name=${name} seq=${JSON.stringify(seq)} raw=${JSON.stringify(raw)} shift=${evt.shift} ctrl=${evt.ctrl} mode=${mode()} dialogOpen=${props.api.ui.dialog.open}`);
    if (!props.api.ui.dialog.open)
      return;
    const active = (() => {
      try {
        return props.isActive?.() ?? props.api.ui.dialog.open;
      } catch {
        return props.api.ui.dialog.open;
      }
    })();
    if (!active)
      return;
    const isColon = name === ":" || seq === ":" || raw === ":" || seq.includes(":") || raw.includes(":") || name === ";" || name === "colon";
    const isQuestion = name === "?" || seq === "?" || raw === "?" || seq.includes("?") || raw.includes("?");
    debugLog("isColon", isColon, "isQuestion", isQuestion, "modeBefore", mode());
    if (mode() === "insert") {
      if (isEnterKey(evt)) {
        prevent(evt);
        debugLog("insert enter -> execute");
        executeCommand(commandInput());
        return;
      }
      if (isEscapeKey(evt) || isCtrlN(evt)) {
        prevent(evt);
        returnToNormalMode();
        debugLog("insert -> normal via esc/ctrl+n");
        return;
      }
      return;
    }
    if (isColon) {
      prevent(evt);
      enterInsertMode();
      debugLog("normal -> insert");
      return;
    }
    if (isQuestion) {
      prevent(evt);
      setShowHelp((value) => !value);
      debugLog("toggle help");
      return;
    }
    const key = raw || seq || name;
    if (key === "c") {
      prevent(evt);
      setShowCompleted((v) => !v);
      debugLog("toggle completed");
      return;
    }
    const currentGoals = state()?.goals.filter((goal) => showCompleted() || goal.status !== "complete") || [];
    const currentCommands = ownerCommands();
    if (name === "tab") {
      prevent(evt);
      setTab((v) => toggleDashboardView(v));
      debugLog("switch tab ->", tab());
      return;
    }
    const directionalView = dashboardViewForKey(key);
    if (directionalView !== undefined) {
      prevent(evt);
      setTab(directionalView);
      debugLog("select tab ->", tab());
      return;
    }
    function dashboardSelection() {
      return {
        view: tab(),
        goalIndex: selected(),
        commandIndex: cmdSelected()
      };
    }
    function applyMove(move) {
      const next = moveDashboardSelection(dashboardSelection(), move, currentGoals.length, currentCommands.length);
      setSelected(next.goalIndex);
      setCmdSelected(next.commandIndex);
    }
    if (name === "down" || key === "j") {
      prevent(evt);
      applyMove("down");
      return;
    }
    if (name === "up" || key === "k") {
      prevent(evt);
      applyMove("up");
      return;
    }
    if (key === "g") {
      prevent(evt);
      applyMove("first");
      return;
    }
    if (key === "G") {
      prevent(evt);
      applyMove("last");
      return;
    }
    const needsGoalsTab = ["p", "r", "R", "x", "A", "N"].includes(key);
    if (needsGoalsTab && tab() !== "goals") {
      prevent(evt);
      setStatusText("Goal controls need the Goals tab (Tab to switch).");
      return;
    }
    if (key === "p") {
      prevent(evt);
      executeCommand("pause");
      return;
    }
    if (key === "r") {
      prevent(evt);
      executeCommand("resume");
      return;
    }
    if (key === "R") {
      prevent(evt);
      executeCommand("retry");
      return;
    }
    if (key === "x") {
      prevent(evt);
      executeCommand("clear");
      return;
    }
    if (key === "A") {
      prevent(evt);
      executeCommand("abort");
      return;
    }
    if (key === "N") {
      prevent(evt);
      executeCommand("nudge");
      return;
    }
    if (key === "L") {
      prevent(evt);
      setShowLogs((value) => !value);
      return;
    }
    if (key === "o") {
      prevent(evt);
      const target = resolveDashboardOpen({
        goals: currentGoals,
        commands: state()?.commands ?? []
      }, dashboardSelection(), ownerSessionID(), currentRouteSessionID(props.api));
      if (target.kind === "goal") {
        props.api.route.navigate("session", {
          sessionID: target.workerSessionID
        });
        props.api.ui.dialog.clear();
      } else if (target.kind === "command") {
        if (props.onOpenCommand) {
          props.onOpenCommand(target.data);
        } else {
          try {
            props.api.route.navigate(TERMINAL_ROUTE_NAME, terminalRoutePayload(target.data.commandID, target.data.ownerSessionID, target.data.returnSessionID));
            props.api.ui.dialog.clear();
          } catch {
            setStatusText("Fullscreen route unavailable on this host.");
          }
        }
      } else {
        setStatusText(target.reason === "no-worker-session" ? "No worker session" : target.reason === "no-command" ? "No command selected." : target.reason === "owner-required" ? "No owning session \u2014 open disabled." : target.reason === "return-required" ? "No return session \u2014 open disabled." : "Nothing to open.");
      }
      return;
    }
    if (key === "B") {
      prevent(evt);
      handleBugReport();
      return;
    }
    if (key === "q") {
      prevent(evt);
      props.api.ui.dialog.clear();
      return;
    }
  });
  const goals = () => state()?.goals.filter((g) => showCompleted() || g.status !== "complete") || [];
  async function executeCommandRaw(command, args, commandID) {
    const owner = ownerSessionID();
    if (!owner) {
      setStatusText("No owning session (open from a session view) \u2014 mutations disabled.");
      return;
    }
    setStatusText(`sending ${command}\u2026`);
    try {
      const r = await client.executeRaw({
        command,
        goalID: commandID,
        args: {
          ...args,
          ownerSessionID: owner
        }
      });
      setStatusText(r.ok ? r.message : `Error: ${r.message}`);
      if (r.ok)
        await refresh();
    } catch (e) {
      setStatusText(`Error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  function selectedCommand() {
    return ownerCommands()[cmdSelected()] ?? null;
  }
  async function executeCommandTabCommand(verb, positional, raw) {
    debugLog("commands-tab command", verb);
    switch (verb) {
      case "new": {
        const argv = parseNewCommand(raw);
        if (!argv) {
          setStatusText("Usage: :new <command> [args...]");
          return;
        }
        const {
          command,
          cmdArgs
        } = argv;
        await executeCommandRaw("cmd_start", {
          title: command,
          command,
          cmdArgs
        });
        return;
      }
      case "interrupt":
        if (!selectedCommand()) {
          setStatusText("No command selected.");
          return;
        }
        await executeCommandRaw("cmd_interrupt", {
          commandID: selectedCommand().id
        }, selectedCommand().id);
        return;
      case "terminate":
        if (!selectedCommand()) {
          setStatusText("No command selected.");
          return;
        }
        await executeCommandRaw("cmd_terminate", {
          commandID: selectedCommand().id
        }, selectedCommand().id);
        return;
      case "remove":
        if (!selectedCommand()) {
          setStatusText("No command selected.");
          return;
        }
        await executeCommandRaw("cmd_remove", {
          commandID: selectedCommand().id
        }, selectedCommand().id);
        return;
      case "logs":
        setShowLogs(!showLogs());
        return;
      case "help":
        setShowHelp(true);
        return;
      default: {
        if (selectedCommand()) {
          const payload = raw.endsWith(`
`) ? raw : `${raw}
`;
          await executeCommandRaw("cmd_write", {
            commandID: selectedCommand().id,
            input: payload
          }, selectedCommand().id);
        } else
          setStatusText(`Unknown: ${verb}. ? for help`);
      }
    }
  }
  async function executeCommand(cmd) {
    debugLog("executeCommand raw=", JSON.stringify(cmd));
    const parsed = parseCommand(cmd);
    debugLog("parsed", parsed);
    if (!parsed) {
      setStatusText("Empty command");
      debugLog("empty command");
      return;
    }
    if (tab() === "commands" && !["q", "close"].includes(parsed.command)) {
      await executeCommandTabCommand(parsed.command, parsed.positional, parsed.raw);
      returnToNormalMode();
      return;
    }
    if (!["help", "logs", "q", "close"].includes(parsed.command)) {
      setStatusText(`sending ${parsed.command}\u2026`);
    }
    try {
      switch (parsed.command) {
        case "send": {
          if (!selectedGoal()) {
            setStatusText("No goal selected");
            break;
          }
          const message = parsed.positional.join(" ") || parsed.args.message || "";
          if (!message) {
            setStatusText("Usage: :send <message>");
            break;
          }
          const r = await client.execute({
            version: 1,
            requestID: randomUUID2(),
            requestedAt: new Date().toISOString(),
            command: "send",
            goalID: selectedGoal().id,
            args: {
              message
            }
          });
          setStatusText(r.ok ? r.message : `Error: ${r.message}`);
          if (r.ok)
            await refresh();
          break;
        }
        case "open": {
          const goal = selectedGoal();
          if (!goal?.workerSessionID) {
            setStatusText("No worker session");
            break;
          }
          props.api.route.navigate("session", {
            sessionID: goal.workerSessionID
          });
          props.api.ui.dialog.clear();
          return;
        }
        case "force": {
          if (!selectedGoal()) {
            setStatusText("No goal");
            break;
          }
          const summary = parsed.positional.join(" ") || parsed.args.summary || "Force-completed from dashboard.";
          const evidence = parsed.args.evidence || "Manual override \u2014 no verification checks run.";
          const r = await client.execute({
            version: 1,
            requestID: randomUUID2(),
            requestedAt: new Date().toISOString(),
            command: "force_complete",
            goalID: selectedGoal().id,
            args: {
              summary,
              evidence
            }
          });
          setStatusText(r.ok ? r.message : `Error: ${r.message}`);
          if (r.ok)
            await refresh();
          break;
        }
        case "block": {
          if (!selectedGoal()) {
            setStatusText("No goal");
            break;
          }
          const reason = parsed.positional.join(" ") || parsed.args.reason || "Blocked from dashboard.";
          const needed = parsed.args.needed || "User intervention required.";
          const r = await client.execute({
            version: 1,
            requestID: randomUUID2(),
            requestedAt: new Date().toISOString(),
            command: "block",
            goalID: selectedGoal().id,
            args: {
              reason,
              needed
            }
          });
          setStatusText(r.ok ? r.message : `Error: ${r.message}`);
          if (r.ok)
            await refresh();
          break;
        }
        case "pause": {
          if (!selectedGoal()) {
            setStatusText("No goal");
            break;
          }
          const r = await client.execute({
            version: 1,
            requestID: randomUUID2(),
            requestedAt: new Date().toISOString(),
            command: "pause",
            goalID: selectedGoal().id
          });
          setStatusText(r.ok ? r.message : `Error: ${r.message}`);
          if (r.ok)
            await refresh();
          break;
        }
        case "resume": {
          if (!selectedGoal()) {
            setStatusText("No goal");
            break;
          }
          const r = await client.execute({
            version: 1,
            requestID: randomUUID2(),
            requestedAt: new Date().toISOString(),
            command: "resume",
            goalID: selectedGoal().id
          });
          setStatusText(r.ok ? r.message : `Error: ${r.message}`);
          if (r.ok)
            await refresh();
          break;
        }
        case "retry": {
          if (!selectedGoal()) {
            setStatusText("No goal");
            break;
          }
          const r = await client.execute({
            version: 1,
            requestID: randomUUID2(),
            requestedAt: new Date().toISOString(),
            command: "retry",
            goalID: selectedGoal().id
          });
          setStatusText(r.ok ? r.message : `Error: ${r.message}`);
          if (r.ok)
            await refresh();
          break;
        }
        case "clear": {
          if (!selectedGoal()) {
            setStatusText("No goal");
            break;
          }
          const r = await client.execute({
            version: 1,
            requestID: randomUUID2(),
            requestedAt: new Date().toISOString(),
            command: "clear",
            goalID: selectedGoal().id
          });
          setStatusText(r.ok ? r.message : `Error: ${r.message}`);
          if (r.ok)
            await refresh();
          break;
        }
        case "abort": {
          if (!selectedGoal()) {
            setStatusText("No goal");
            break;
          }
          const r = await client.execute({
            version: 1,
            requestID: randomUUID2(),
            requestedAt: new Date().toISOString(),
            command: "abort_worker",
            goalID: selectedGoal().id
          });
          setStatusText(r.ok ? r.message : `Error: ${r.message}`);
          if (r.ok)
            await refresh();
          break;
        }
        case "nudge": {
          if (!selectedGoal()) {
            setStatusText("No goal");
            break;
          }
          const r = await client.execute({
            version: 1,
            requestID: randomUUID2(),
            requestedAt: new Date().toISOString(),
            command: "nudge",
            goalID: selectedGoal().id
          });
          setStatusText(r.ok ? r.message : `Error: ${r.message}`);
          if (r.ok)
            await refresh();
          break;
        }
        case "goal": {
          setStatusText("Create goals via /goal in the parent chat (agent clarifies first). Dashboard: :send to steer the worker.");
          break;
        }
        case "bug":
        case "report": {
          handleBugReport();
          break;
        }
        case "logs":
          setShowLogs(!showLogs());
          break;
        case "help":
          setShowHelp(true);
          break;
        case "q":
        case "close":
          props.api.ui.dialog.clear();
          return;
        default: {
          if (parsed.command && selectedGoal()) {
            const message = parsed.raw;
            const r = await client.execute({
              version: 1,
              requestID: randomUUID2(),
              requestedAt: new Date().toISOString(),
              command: "send",
              goalID: selectedGoal().id,
              args: {
                message
              }
            });
            setStatusText(r.ok ? `sent: ${message.slice(0, 80)}` : `Error: ${r.message}`);
            if (r.ok)
              await refresh();
          } else
            setStatusText(`Unknown: ${parsed.command}. ? for help`);
        }
      }
    } catch (e) {
      setStatusText(`Error: ${e instanceof Error ? e.message : String(e)}`);
    }
    returnToNormalMode();
  }
  const activeGoals = () => state()?.goals.filter((g) => showCompleted() || g.status !== "complete") || [];
  const listHeight = () => Math.min(activeGoals().length, 10);
  const runningCount = () => state()?.runtimes.filter((runtime) => runtime.phase === "running").length || 0;
  const runningFrame = () => ["|", "/", "-", "\\"][Math.floor(clock() / 500) % 4];
  function handleBugReport() {
    const goal = selectedGoal();
    const extra = goal ? `Goal: ${goal.name} (${goal.id.slice(0, 8)}) status=${goal.status} objective=${goal.objective.slice(0, 120)}` : "No goal selected";
    const url = bugReportUrl({
      runtimeLabel: `opencode-loopd dashboard`,
      extra
    });
    const res = openBrowserUrl(url);
    setStatusText(res.status === "opened" ? "Opening bug report in browser\u2026" : `Could not open browser: ${res.reason} \u2014 ${url}`);
  }
  createEffect(() => setSelectedGoal(activeGoals()[selected()] || null));
  function rowIdFor(goalID) {
    return `loopd-goal-${goalID}`;
  }
  createEffect(() => {
    const goals = activeGoals();
    const goal = goals[selected()];
    if (!goal || !listScrollRef)
      return;
    try {
      listScrollRef.scrollChildIntoView(rowIdFor(goal.id));
    } catch {}
  });
  return (() => {
    var _el$ = _$createElement("box"), _el$2 = _$createElement("box"), _el$3 = _$createElement("box"), _el$4 = _$createElement("text"), _el$5 = _$createElement("span"), _el$7 = _$createElement("span"), _el$9 = _$createElement("span"), _el$0 = _$createTextNode(` `), _el$1 = _$createTextNode(` `), _el$10 = _$createElement("span"), _el$12 = _$createElement("span"), _el$13 = _$createElement("span"), _el$15 = _$createElement("span"), _el$17 = _$createElement("span"), _el$18 = _$createTextNode(` `), _el$19 = _$createTextNode(` acting now`), _el$20 = _$createElement("span"), _el$22 = _$createElement("span"), _el$23 = _$createElement("span"), _el$25 = _$createElement("span"), _el$27 = _$createElement("span"), _el$29 = _$createElement("span"), _el$31 = _$createElement("span"), _el$33 = _$createElement("span"), _el$35 = _$createElement("box"), _el$36 = _$createElement("text"), _el$37 = _$createElement("span"), _el$39 = _$createElement("box"), _el$52 = _$createElement("box"), _el$53 = _$createElement("text"), _el$54 = _$createElement("span"), _el$55 = _$createElement("input");
    _$insertNode(_el$, _el$2);
    _$setProp(_el$, "flexDirection", "column");
    _$setProp(_el$, "width", "100%");
    _$setProp(_el$, "alignItems", "center");
    _$setProp(_el$, "padding", 1);
    _$insertNode(_el$2, _el$3);
    _$insertNode(_el$2, _el$39);
    _$insertNode(_el$2, _el$52);
    _$setProp(_el$2, "flexDirection", "column");
    _$setProp(_el$2, "width", "90%");
    _$setProp(_el$2, "border", true);
    _$setProp(_el$2, "padding", 1);
    _$insertNode(_el$3, _el$4);
    _$insertNode(_el$3, _el$35);
    _$setProp(_el$3, "flexDirection", "row");
    _$setProp(_el$3, "justifyContent", "space-between");
    _$setProp(_el$3, "alignItems", "center");
    _$setProp(_el$3, "padding", 0);
    _$setProp(_el$3, "flexShrink", 0);
    _$setProp(_el$3, "gap", 1);
    _$insertNode(_el$4, _el$5);
    _$insertNode(_el$4, _el$7);
    _$insertNode(_el$4, _el$9);
    _$insertNode(_el$4, _el$10);
    _$insertNode(_el$4, _el$12);
    _$insertNode(_el$4, _el$13);
    _$insertNode(_el$4, _el$15);
    _$insertNode(_el$4, _el$17);
    _$insertNode(_el$4, _el$20);
    _$insertNode(_el$4, _el$22);
    _$insertNode(_el$4, _el$23);
    _$insertNode(_el$4, _el$25);
    _$insertNode(_el$4, _el$27);
    _$insertNode(_el$4, _el$29);
    _$insertNode(_el$4, _el$31);
    _$insertNode(_el$4, _el$33);
    _$insertNode(_el$5, _$createTextNode(`\u2B22 Loop Dashboard`));
    _$insertNode(_el$7, _$createTextNode(` \u2502 `));
    _$insertNode(_el$9, _el$0);
    _$insertNode(_el$9, _el$1);
    _$insert(_el$9, () => mode().toUpperCase(), _el$1);
    _$insertNode(_el$10, _$createTextNode(` \u2502 `));
    _$insert(_el$12, () => activeGoals().length);
    _$insertNode(_el$13, _$createTextNode(` open`));
    _$insertNode(_el$15, _$createTextNode(` \u2502 `));
    _$insertNode(_el$17, _el$18);
    _$insertNode(_el$17, _el$19);
    _$insert(_el$17, (() => {
      var _c$ = _$memo(() => runningCount() > 0);
      return () => _c$() ? runningFrame() : "\u25CB";
    })(), _el$18);
    _$insert(_el$17, runningCount, _el$19);
    _$insertNode(_el$20, _$createTextNode(` \u2502 `));
    _$insert(_el$22, () => state()?.goals.filter((g) => g.status === "complete").length || 0);
    _$insertNode(_el$23, _$createTextNode(` done`));
    _$insertNode(_el$25, _$createTextNode(` \u2502 `));
    _$insertNode(_el$27, _$createTextNode(`[Goals]`));
    _$insertNode(_el$29, _$createTextNode(` `));
    _$insertNode(_el$31, _$createTextNode(`[Commands]`));
    _$insertNode(_el$33, _$createTextNode(` (Tab)`));
    _$insertNode(_el$35, _el$36);
    _$setProp(_el$35, "flexDirection", "row");
    _$setProp(_el$35, "alignItems", "center");
    _$setProp(_el$35, "paddingLeft", 1);
    _$setProp(_el$35, "paddingRight", 1);
    _$setProp(_el$35, "flexShrink", 0);
    _$spread(_el$35, _$mergeProps({
      get backgroundColor() {
        return theme().error;
      }
    }, {
      onMouseDown: handleBugReport
    }), true);
    _$insertNode(_el$36, _el$37);
    _$insertNode(_el$37, _$createTextNode(`Bug Report`));
    _$setProp(_el$37, "style", {
      fg: "white",
      bold: true
    });
    _$setProp(_el$39, "flexDirection", "column");
    _$setProp(_el$39, "flexShrink", 1);
    _$setProp(_el$39, "minHeight", 0);
    _$setProp(_el$39, "overflow", "hidden");
    _$insert(_el$39, _$createComponent(Show, {
      get when() {
        return showHelp();
      },
      get children() {
        var _el$40 = _$createElement("box"), _el$41 = _$createElement("text"), _el$42 = _$createElement("span");
        _$insertNode(_el$40, _el$41);
        _$setProp(_el$40, "flexDirection", "column");
        _$setProp(_el$40, "padding", 1);
        _$setProp(_el$40, "border", true);
        _$setProp(_el$40, "borderColor", "yellow");
        _$setProp(_el$40, "flexShrink", 0);
        _$setProp(_el$40, "maxHeight", 14);
        _$setProp(_el$40, "overflow", "hidden");
        _$insertNode(_el$41, _el$42);
        _$insertNode(_el$42, _$createTextNode(`\u2501\u2501\u2501 Keys: ? toggle help c toggle done : insert Ctrl+N normal o open A abort worker N nudge q close \u2501\u2501\u2501`));
        _$setProp(_el$42, "style", {
          fg: "yellow",
          bold: true
        });
        _$insert(_el$41, _$createComponent(For, {
          get each() {
            return commandHelp().split(`
`);
          },
          children: (line) => {
            if (line.startsWith("Modes:") || line.startsWith("Nav:")) {
              const label = line.startsWith("Modes:") ? "Modes:" : "Nav:";
              const rest = line.slice(label.length).trim();
              const segments = rest.split(" | ");
              return [`
`, (() => {
                var _el$56 = _$createElement("span");
                _$insert(_el$56, label);
                _$effect((_$p) => _$setProp(_el$56, "style", {
                  fg: theme().primary,
                  bold: true
                }, _$p));
                return _el$56;
              })(), (() => {
                var _el$57 = _$createElement("span");
                _$insertNode(_el$57, _$createTextNode(` `));
                _$effect((_$p) => _$setProp(_el$57, "style", {
                  fg: theme().textMuted
                }, _$p));
                return _el$57;
              })(), _$createComponent(For, {
                each: segments,
                children: (seg, idx) => {
                  const hasArrow = seg.includes("\u2192");
                  if (hasArrow) {
                    const [k, d] = seg.split("\u2192").map((s) => s.trim());
                    return [_$memo(() => _$memo(() => idx() > 0)() && (() => {
                      var _el$63 = _$createElement("span");
                      _$insertNode(_el$63, _$createTextNode(` | `));
                      _$effect((_$p) => _$setProp(_el$63, "style", {
                        fg: theme().textMuted
                      }, _$p));
                      return _el$63;
                    })()), (() => {
                      var _el$59 = _$createElement("span");
                      _$insert(_el$59, k);
                      _$effect((_$p) => _$setProp(_el$59, "style", {
                        fg: theme().warning,
                        bold: true
                      }, _$p));
                      return _el$59;
                    })(), (() => {
                      var _el$60 = _$createElement("span");
                      _$insertNode(_el$60, _$createTextNode(` \u2192 `));
                      _$effect((_$p) => _$setProp(_el$60, "style", {
                        fg: theme().textMuted
                      }, _$p));
                      return _el$60;
                    })(), (() => {
                      var _el$62 = _$createElement("span");
                      _$insert(_el$62, d);
                      _$effect((_$p) => _$setProp(_el$62, "style", {
                        fg: theme().text
                      }, _$p));
                      return _el$62;
                    })()];
                  }
                  const sp = seg.indexOf(" ");
                  const k = sp > 0 ? seg.slice(0, sp) : seg;
                  const d = sp > 0 ? seg.slice(sp + 1) : "";
                  return [_$memo(() => _$memo(() => idx() > 0)() && (() => {
                    var _el$66 = _$createElement("span");
                    _$insertNode(_el$66, _$createTextNode(` | `));
                    _$effect((_$p) => _$setProp(_el$66, "style", {
                      fg: theme().textMuted
                    }, _$p));
                    return _el$66;
                  })()), (() => {
                    var _el$65 = _$createElement("span");
                    _$insert(_el$65, k);
                    _$effect((_$p) => _$setProp(_el$65, "style", {
                      fg: theme().warning,
                      bold: true
                    }, _$p));
                    return _el$65;
                  })(), d && (() => {
                    var _el$68 = _$createElement("span"), _el$69 = _$createTextNode(` `);
                    _$insertNode(_el$68, _el$69);
                    _$insert(_el$68, d, null);
                    _$effect((_$p) => _$setProp(_el$68, "style", {
                      fg: theme().text
                    }, _$p));
                    return _el$68;
                  })()];
                }
              })];
            }
            if (line.trim().startsWith(":")) {
              const m = line.match(/^(\s*)(:\S+(?:\s+\S+)*?)\s{2,}(.*)$/);
              const indent = m?.[1] ?? line.match(/^\s*/)?.[0] ?? "";
              const key = m?.[2] ?? line.trim().split(/\s{2,}/)[0] ?? line.trim();
              const desc = m?.[3] ?? line.split(/\s{2,}/)[1] ?? "";
              return [`
`, (() => {
                var _el$70 = _$createElement("span");
                _$insert(_el$70, indent);
                _$effect((_$p) => _$setProp(_el$70, "style", {
                  fg: theme().textMuted
                }, _$p));
                return _el$70;
              })(), (() => {
                var _el$71 = _$createElement("span");
                _$insert(_el$71, key);
                _$effect((_$p) => _$setProp(_el$71, "style", {
                  fg: theme().warning,
                  bold: true
                }, _$p));
                return _el$71;
              })(), desc && [(() => {
                var _el$72 = _$createElement("span");
                _$insertNode(_el$72, _$createTextNode(` `));
                _$effect((_$p) => _$setProp(_el$72, "style", {
                  fg: theme().textMuted
                }, _$p));
                return _el$72;
              })(), (() => {
                var _el$74 = _$createElement("span");
                _$insert(_el$74, desc);
                _$effect((_$p) => _$setProp(_el$74, "style", {
                  fg: theme().textMuted
                }, _$p));
                return _el$74;
              })()]];
            }
            const isHeader = line.startsWith("Commands");
            return [`
`, (() => {
              var _el$75 = _$createElement("span");
              _$insert(_el$75, line);
              _$effect((_$p) => _$setProp(_el$75, "style", {
                fg: isHeader ? theme().primary : theme().textMuted,
                bold: isHeader
              }, _$p));
              return _el$75;
            })()];
          }
        }), null);
        _$effect((_$p) => _$setProp(_el$40, "backgroundColor", theme().background, _$p));
        return _el$40;
      }
    }), null);
    _$insert(_el$39, _$createComponent(Show, {
      get when() {
        return tab() === "goals";
      },
      get children() {
        return [_$createComponent(Show, {
          get when() {
            return activeGoals().length > 0;
          },
          get fallback() {
            return (() => {
              var _el$76 = _$createElement("box"), _el$77 = _$createElement("text"), _el$78 = _$createElement("span"), _el$80 = _$createElement("span"), _el$82 = _$createElement("span"), _el$84 = _$createElement("text"), _el$85 = _$createElement("span"), _el$87 = _$createElement("span"), _el$89 = _$createElement("span"), _el$91 = _$createElement("span"), _el$93 = _$createElement("span"), _el$95 = _$createElement("span"), _el$97 = _$createElement("span");
              _$insertNode(_el$76, _el$77);
              _$insertNode(_el$76, _el$84);
              _$setProp(_el$76, "flexDirection", "column");
              _$setProp(_el$76, "gap", 1);
              _$setProp(_el$76, "padding", 1);
              _$insertNode(_el$77, _el$78);
              _$insertNode(_el$77, _el$80);
              _$insertNode(_el$77, _el$82);
              _$insertNode(_el$78, _$createTextNode(`No active goals.`));
              _$insertNode(_el$80, _$createTextNode(` /goal`));
              _$insertNode(_el$82, _$createTextNode(` in parent chat to create one.`));
              _$insertNode(_el$84, _el$85);
              _$insertNode(_el$84, _el$87);
              _$insertNode(_el$84, _el$89);
              _$insertNode(_el$84, _el$91);
              _$insertNode(_el$84, _el$93);
              _$insertNode(_el$84, _el$95);
              _$insertNode(_el$84, _el$97);
              _$insertNode(_el$85, _$createTextNode(`Tip: `));
              _$insertNode(_el$87, _$createTextNode(`:send`));
              _$insertNode(_el$89, _$createTextNode(` to steer the worker \xB7 `));
              _$insertNode(_el$91, _$createTextNode(`o`));
              _$insertNode(_el$93, _$createTextNode(` to open child \xB7 `));
              _$insertNode(_el$95, _$createTextNode(`:force`));
              _$insertNode(_el$97, _$createTextNode(` to complete manually.`));
              _$effect((_p$) => {
                var _v$26 = {
                  fg: theme().textMuted
                }, _v$27 = {
                  fg: theme().accent
                }, _v$28 = {
                  fg: theme().textMuted
                }, _v$29 = {
                  fg: theme().textMuted
                }, _v$30 = {
                  fg: theme().warning
                }, _v$31 = {
                  fg: theme().textMuted
                }, _v$32 = {
                  fg: theme().warning
                }, _v$33 = {
                  fg: theme().textMuted
                }, _v$34 = {
                  fg: theme().warning
                }, _v$35 = {
                  fg: theme().textMuted
                };
                _v$26 !== _p$.e && (_p$.e = _$setProp(_el$78, "style", _v$26, _p$.e));
                _v$27 !== _p$.t && (_p$.t = _$setProp(_el$80, "style", _v$27, _p$.t));
                _v$28 !== _p$.a && (_p$.a = _$setProp(_el$82, "style", _v$28, _p$.a));
                _v$29 !== _p$.o && (_p$.o = _$setProp(_el$85, "style", _v$29, _p$.o));
                _v$30 !== _p$.i && (_p$.i = _$setProp(_el$87, "style", _v$30, _p$.i));
                _v$31 !== _p$.n && (_p$.n = _$setProp(_el$89, "style", _v$31, _p$.n));
                _v$32 !== _p$.s && (_p$.s = _$setProp(_el$91, "style", _v$32, _p$.s));
                _v$33 !== _p$.h && (_p$.h = _$setProp(_el$93, "style", _v$33, _p$.h));
                _v$34 !== _p$.r && (_p$.r = _$setProp(_el$95, "style", _v$34, _p$.r));
                _v$35 !== _p$.d && (_p$.d = _$setProp(_el$97, "style", _v$35, _p$.d));
                return _p$;
              }, {
                e: undefined,
                t: undefined,
                a: undefined,
                o: undefined,
                i: undefined,
                n: undefined,
                s: undefined,
                h: undefined,
                r: undefined,
                d: undefined
              });
              return _el$76;
            })();
          },
          get children() {
            var _el$44 = _$createElement("scrollbox");
            _$use((el) => {
              listScrollRef = el;
            }, _el$44);
            _$insert(_el$44, _$createComponent(For, {
              get each() {
                return activeGoals();
              },
              children: (goal, i) => {
                const runtime = () => state()?.runtimes.find((r) => r.goalID === goal.id);
                const isActive = () => i() === selected();
                const maxTurns = goal.config?.maxTurns;
                const turnColor = () => {
                  if (!runtime() || !maxTurns)
                    return phaseColor(runtime()?.phase || "idle", theme());
                  const ratio = runtime().budgetTurnCount / maxTurns;
                  if (ratio >= 1)
                    return theme().error;
                  if (ratio >= 0.8)
                    return theme().warning;
                  return phaseColor(runtime().phase || "idle", theme());
                };
                return (() => {
                  var _el$99 = _$createElement("box"), _el$100 = _$createElement("text"), _el$101 = _$createElement("span"), _el$102 = _$createElement("span"), _el$104 = _$createElement("span"), _el$106 = _$createElement("span");
                  _$insertNode(_el$99, _el$100);
                  _$setProp(_el$99, "flexDirection", "row");
                  _$setProp(_el$99, "paddingLeft", 1);
                  _$setProp(_el$99, "paddingRight", 1);
                  _$insertNode(_el$100, _el$101);
                  _$insertNode(_el$100, _el$102);
                  _$insertNode(_el$100, _el$104);
                  _$insertNode(_el$100, _el$106);
                  _$setProp(_el$100, "wrapMode", "none");
                  _$setProp(_el$100, "truncate", true);
                  _$insert(_el$101, (() => {
                    var _c$2 = _$memo(() => !!isActive());
                    return () => _c$2() ? `\u25B6 ${statusIcon(goal.status)} ${goal.name}` : `  ${statusIcon(goal.status)} ${goal.name}`;
                  })());
                  _$insertNode(_el$102, _$createTextNode(` \u2502 `));
                  _$insertNode(_el$104, _$createTextNode(`Goal `));
                  _$insert(_el$106, () => goalStatusLabel(goal.status).short.toUpperCase());
                  _$insert(_el$100, (() => {
                    var _c$3 = _$memo(() => !!runtime());
                    return () => _c$3() && [(() => {
                      var _el$107 = _$createElement("span");
                      _$insertNode(_el$107, _$createTextNode(` \u2502 Worker `));
                      _$effect((_$p) => _$setProp(_el$107, "style", {
                        fg: theme().textMuted
                      }, _$p));
                      return _el$107;
                    })(), (() => {
                      var _el$109 = _$createElement("span"), _el$110 = _$createTextNode(` `);
                      _$insertNode(_el$109, _el$110);
                      _$insert(_el$109, (() => {
                        var _c$1 = _$memo(() => runtime().phase === "running");
                        return () => _c$1() ? runningFrame() : phaseIcon(runtime().phase);
                      })(), _el$110);
                      _$insert(_el$109, () => phaseLabel(runtime().phase).short.toUpperCase(), null);
                      _$effect((_$p) => _$setProp(_el$109, "style", {
                        fg: turnColor(),
                        bold: runtime().phase === "running"
                      }, _$p));
                      return _el$109;
                    })(), (() => {
                      var _el$111 = _$createElement("span"), _el$112 = _$createTextNode(` `);
                      _$insertNode(_el$111, _el$112);
                      _$insert(_el$111, () => runtime().budgetTurnCount, null);
                      _$insert(_el$111, maxTurns ? `/${maxTurns}` : "", null);
                      _$effect((_$p) => _$setProp(_el$111, "style", {
                        fg: turnColor()
                      }, _$p));
                      return _el$111;
                    })(), (() => {
                      var _el$113 = _$createElement("span"), _el$114 = _$createTextNode(` `);
                      _$insertNode(_el$113, _el$114);
                      _$insert(_el$113, () => ageLabel(runtime().lastProgressAt || runtime().lastRunAt, clock()), null);
                      _$effect((_$p) => _$setProp(_el$113, "style", {
                        fg: theme().textMuted
                      }, _$p));
                      return _el$113;
                    })()];
                  })(), null);
                  _$insert(_el$100, (() => {
                    var _c$4 = _$memo(() => !!(runtime() && runtime().consecutiveFailures > 0));
                    return () => _c$4() && (() => {
                      var _el$115 = _$createElement("span"), _el$116 = _$createTextNode(` \u2502 \u26A0 `), _el$117 = _$createTextNode(` fail`);
                      _$insertNode(_el$115, _el$116);
                      _$insertNode(_el$115, _el$117);
                      _$insert(_el$115, () => runtime().consecutiveFailures, _el$117);
                      _$effect((_$p) => _$setProp(_el$115, "style", {
                        fg: theme().error,
                        bold: true
                      }, _$p));
                      return _el$115;
                    })();
                  })(), null);
                  _$insert(_el$100, (() => {
                    var _c$5 = _$memo(() => !!(runtime() && (runtime().noProgressCount || 0) > 0));
                    return () => _c$5() && (() => {
                      var _el$118 = _$createElement("span"), _el$119 = _$createTextNode(` \u2502 `), _el$120 = _$createTextNode(` no-progress`);
                      _$insertNode(_el$118, _el$119);
                      _$insertNode(_el$118, _el$120);
                      _$insert(_el$118, () => runtime().noProgressCount, _el$120);
                      _$effect((_$p) => _$setProp(_el$118, "style", {
                        fg: theme().warning
                      }, _$p));
                      return _el$118;
                    })();
                  })(), null);
                  _$insert(_el$100, (() => {
                    var _c$6 = _$memo(() => !!(runtime() && runtime().evaluatorRejectionCount > 0));
                    return () => _c$6() && (() => {
                      var _el$121 = _$createElement("span"), _el$122 = _$createTextNode(` \u2502 \u26A0 `), _el$123 = _$createTextNode(` rejected`);
                      _$insertNode(_el$121, _el$122);
                      _$insertNode(_el$121, _el$123);
                      _$insert(_el$121, () => String(runtime().evaluatorRejectionCount), _el$123);
                      _$effect((_$p) => _$setProp(_el$121, "style", {
                        fg: theme().warning,
                        bold: true
                      }, _$p));
                      return _el$121;
                    })();
                  })(), null);
                  _$insert(_el$100, (() => {
                    var _c$7 = _$memo(() => !!(runtime() && runtime().unknownStatusCount >= 3));
                    return () => _c$7() && (() => {
                      var _el$124 = _$createElement("span");
                      _$insertNode(_el$124, _$createTextNode(` \u2502 \u26A0\uFE0F UNREACHABLE`));
                      _$effect((_$p) => _$setProp(_el$124, "style", {
                        fg: theme().error,
                        bold: true
                      }, _$p));
                      return _el$124;
                    })();
                  })(), null);
                  _$insert(_el$100, (() => {
                    var _c$8 = _$memo(() => !!(runtime() && runtime().phase === "idle" && runtime().activeRunID));
                    return () => _c$8() && (() => {
                      var _el$126 = _$createElement("span");
                      _$insertNode(_el$126, _$createTextNode(` \u2502 \u26A0\uFE0F STALE LEASE`));
                      _$effect((_$p) => _$setProp(_el$126, "style", {
                        fg: theme().error,
                        bold: true
                      }, _$p));
                      return _el$126;
                    })();
                  })(), null);
                  _$insert(_el$100, (() => {
                    var _c$9 = _$memo(() => !!(runtime() && runtime().retryAfter));
                    return () => _c$9() && (() => {
                      var _el$128 = _$createElement("span"), _el$129 = _$createTextNode(` \u2502 \u21BB `);
                      _$insertNode(_el$128, _el$129);
                      _$insert(_el$128, () => countdownLabel(runtime().retryAfter, clock()), null);
                      _$effect((_$p) => _$setProp(_el$128, "style", {
                        fg: theme().accent
                      }, _$p));
                      return _el$128;
                    })();
                  })(), null);
                  _$insert(_el$100, (() => {
                    var _c$0 = _$memo(() => !!(runtime() && runtime().nextRunAt));
                    return () => _c$0() && (() => {
                      var _el$130 = _$createElement("span"), _el$131 = _$createTextNode(` \u2502 \u23F0 `);
                      _$insertNode(_el$130, _el$131);
                      _$insert(_el$130, () => countdownLabel(runtime().nextRunAt, clock()), null);
                      _$effect((_$p) => _$setProp(_el$130, "style", {
                        fg: theme().accent
                      }, _$p));
                      return _el$130;
                    })();
                  })(), null);
                  _$effect((_p$) => {
                    var _v$36 = rowIdFor(goal.id), _v$37 = isActive() ? theme().backgroundElement : undefined, _v$38 = {
                      fg: statusColor(goal.status, theme()),
                      bold: isActive()
                    }, _v$39 = {
                      fg: theme().textMuted
                    }, _v$40 = {
                      fg: theme().textMuted
                    }, _v$41 = {
                      fg: statusColor(goal.status, theme()),
                      bold: true
                    };
                    _v$36 !== _p$.e && (_p$.e = _$setProp(_el$99, "id", _v$36, _p$.e));
                    _v$37 !== _p$.t && (_p$.t = _$setProp(_el$99, "backgroundColor", _v$37, _p$.t));
                    _v$38 !== _p$.a && (_p$.a = _$setProp(_el$101, "style", _v$38, _p$.a));
                    _v$39 !== _p$.o && (_p$.o = _$setProp(_el$102, "style", _v$39, _p$.o));
                    _v$40 !== _p$.i && (_p$.i = _$setProp(_el$104, "style", _v$40, _p$.i));
                    _v$41 !== _p$.n && (_p$.n = _$setProp(_el$106, "style", _v$41, _p$.n));
                    return _p$;
                  }, {
                    e: undefined,
                    t: undefined,
                    a: undefined,
                    o: undefined,
                    i: undefined,
                    n: undefined
                  });
                  return _el$99;
                })();
              }
            }));
            _$effect((_$p) => _$setProp(_el$44, "height", listHeight(), _$p));
            return _el$44;
          }
        }), _$createComponent(Show, {
          get when() {
            return selectedGoal();
          },
          children: (goal) => {
            const rt = () => state()?.runtimes.find((r) => r.goalID === goal().id);
            const lp = () => goal().lastProgress;
            const blk = () => goal().blocker;
            return (() => {
              var _el$132 = _$createElement("box"), _el$133 = _$createElement("text"), _el$134 = _$createElement("span"), _el$135 = _$createTextNode(` `), _el$136 = _$createElement("span"), _el$138 = _$createElement("span"), _el$139 = _$createTextNode(` \u2014 `), _el$140 = _$createTextNode(`
`), _el$141 = _$createElement("span"), _el$142 = _$createTextNode(`
`), _el$143 = _$createElement("span"), _el$145 = _$createElement("span");
              _$insertNode(_el$132, _el$133);
              _$setProp(_el$132, "flexDirection", "column");
              _$setProp(_el$132, "border", true);
              _$setProp(_el$132, "padding", 1);
              _$setProp(_el$132, "flexShrink", 0);
              _$setProp(_el$132, "maxHeight", 13);
              _$insertNode(_el$133, _el$134);
              _$insertNode(_el$133, _el$136);
              _$insertNode(_el$133, _el$138);
              _$insertNode(_el$133, _el$140);
              _$insertNode(_el$133, _el$141);
              _$insertNode(_el$133, _el$142);
              _$insertNode(_el$133, _el$143);
              _$insertNode(_el$133, _el$145);
              _$insertNode(_el$134, _el$135);
              _$insert(_el$134, () => statusIcon(goal().status), _el$135);
              _$insert(_el$134, () => goal().name, null);
              _$insertNode(_el$136, _$createTextNode(` Goal `));
              _$insertNode(_el$138, _el$139);
              _$insert(_el$138, () => goalStatusLabel(goal().status).short, _el$139);
              _$insert(_el$138, () => goalStatusLabel(goal().status).hint, null);
              _$insert(_el$133, (() => {
                var _c$10 = _$memo(() => !!rt());
                return () => _c$10() && [(() => {
                  var _el$146 = _$createElement("span");
                  _$insertNode(_el$146, _$createTextNode(` \u2502 Worker `));
                  _$effect((_$p) => _$setProp(_el$146, "style", {
                    fg: theme().textMuted
                  }, _$p));
                  return _el$146;
                })(), (() => {
                  var _el$148 = _$createElement("span"), _el$149 = _$createTextNode(` `), _el$150 = _$createTextNode(` \u2014 `);
                  _$insertNode(_el$148, _el$149);
                  _$insertNode(_el$148, _el$150);
                  _$insert(_el$148, () => phaseIcon(rt().phase), _el$149);
                  _$insert(_el$148, () => phaseLabel(rt().phase).short, _el$150);
                  _$insert(_el$148, () => phaseLabel(rt().phase).hint, null);
                  _$effect((_$p) => _$setProp(_el$148, "style", {
                    fg: phaseColor(rt().phase, theme()),
                    bold: true
                  }, _$p));
                  return _el$148;
                })(), (() => {
                  var _el$151 = _$createElement("span"), _el$152 = _$createTextNode(` run `), _el$153 = _$createTextNode(` (budget `), _el$154 = _$createTextNode(`)`);
                  _$insertNode(_el$151, _el$152);
                  _$insertNode(_el$151, _el$153);
                  _$insertNode(_el$151, _el$154);
                  _$insert(_el$151, () => rt().runCount, _el$153);
                  _$insert(_el$151, () => rt().budgetTurnCount, _el$154);
                  _$effect((_$p) => _$setProp(_el$151, "style", {
                    fg: theme().textMuted
                  }, _$p));
                  return _el$151;
                })()];
              })(), _el$140);
              _$insert(_el$141, () => describeGoalState(goal().status, rt()?.phase));
              _$insert(_el$133, (() => {
                var _c$11 = _$memo(() => !!rt()?.workerAbortedAt);
                return () => _c$11() && [(() => {
                  var _el$155 = _$createElement("span");
                  _$insertNode(_el$155, _$createTextNode(` \u2502 \u26A0 worker aborted `));
                  _$effect((_$p) => _$setProp(_el$155, "style", {
                    fg: theme().warning,
                    bold: true
                  }, _$p));
                  return _el$155;
                })(), (() => {
                  var _el$157 = _$createElement("span"), _el$158 = _$createTextNode(` \u2014 session kept, next turn reuses it`);
                  _$insertNode(_el$157, _el$158);
                  _$insert(_el$157, () => ageLabel(rt().workerAbortedAt, clock()), _el$158);
                  _$effect((_$p) => _$setProp(_el$157, "style", {
                    fg: theme().textMuted
                  }, _$p));
                  return _el$157;
                })()];
              })(), _el$142);
              _$insert(_el$133, () => {
                const agentName = goal().config.agent;
                const meta = agentName ? agentIndex()[agentName] ?? agentIndex()[agentName.toLowerCase()] : undefined;
                const model = goal().config.model;
                const slash = model?.indexOf("/") ?? -1;
                return [`
`, (() => {
                  var _el$159 = _$createElement("span");
                  _$insertNode(_el$159, _$createTextNode(`\uD83E\uDD16 `));
                  _$effect((_$p) => _$setProp(_el$159, "style", {
                    fg: theme().textMuted
                  }, _$p));
                  return _el$159;
                })(), (() => {
                  var _el$161 = _$createElement("span");
                  _$insertNode(_el$161, _$createTextNode(`Agent: `));
                  _$effect((_$p) => _$setProp(_el$161, "style", {
                    fg: theme().primary,
                    bold: true
                  }, _$p));
                  return _el$161;
                })(), _$memo(() => agentName ? [(() => {
                  var _el$177 = _$createElement("span");
                  _$insert(_el$177, agentName);
                  _$effect((_$p) => _$setProp(_el$177, "style", {
                    fg: agentColor(meta?.color, theme()),
                    bold: true
                  }, _$p));
                  return _el$177;
                })(), _$memo(() => _$memo(() => !!meta?.mode)() && (() => {
                  var _el$178 = _$createElement("span"), _el$179 = _$createTextNode(` (`), _el$180 = _$createTextNode(`)`);
                  _$insertNode(_el$178, _el$179);
                  _$insertNode(_el$178, _el$180);
                  _$insert(_el$178, () => meta.mode, _el$180);
                  _$effect((_$p) => _$setProp(_el$178, "style", {
                    fg: theme().textMuted
                  }, _$p));
                  return _el$178;
                })())] : goal().parentAgent ? [(() => {
                  var _el$181 = _$createElement("span");
                  _$insertNode(_el$181, _$createTextNode(`\u21A9 `));
                  _$effect((_$p) => _$setProp(_el$181, "style", {
                    fg: theme().textMuted
                  }, _$p));
                  return _el$181;
                })(), (() => {
                  var _el$183 = _$createElement("span");
                  _$insert(_el$183, () => goal().parentAgent);
                  _$effect((_$p) => _$setProp(_el$183, "style", {
                    fg: theme().text,
                    bold: true
                  }, _$p));
                  return _el$183;
                })(), (() => {
                  var _el$184 = _$createElement("span");
                  _$insertNode(_el$184, _$createTextNode(` (parent)`));
                  _$effect((_$p) => _$setProp(_el$184, "style", {
                    fg: theme().textMuted
                  }, _$p));
                  return _el$184;
                })()] : (() => {
                  var _el$186 = _$createElement("span");
                  _$insertNode(_el$186, _$createTextNode(`parent`));
                  _$effect((_$p) => _$setProp(_el$186, "style", {
                    fg: theme().textMuted
                  }, _$p));
                  return _el$186;
                })()), (() => {
                  var _el$163 = _$createElement("span");
                  _$insertNode(_el$163, _$createTextNode(` \u2502 \uD83E\uDDE0 `));
                  _$effect((_$p) => _$setProp(_el$163, "style", {
                    fg: theme().textMuted
                  }, _$p));
                  return _el$163;
                })(), (() => {
                  var _el$165 = _$createElement("span");
                  _$insertNode(_el$165, _$createTextNode(`Model: `));
                  _$effect((_$p) => _$setProp(_el$165, "style", {
                    fg: theme().primary,
                    bold: true
                  }, _$p));
                  return _el$165;
                })(), _$memo(() => model && slash > 0 ? [(() => {
                  var _el$188 = _$createElement("span"), _el$189 = _$createTextNode(`/`);
                  _$insertNode(_el$188, _el$189);
                  _$insert(_el$188, () => model.slice(0, slash), _el$189);
                  _$effect((_$p) => _$setProp(_el$188, "style", {
                    fg: theme().textMuted
                  }, _$p));
                  return _el$188;
                })(), (() => {
                  var _el$190 = _$createElement("span");
                  _$insert(_el$190, () => model.slice(slash + 1));
                  _$effect((_$p) => _$setProp(_el$190, "style", {
                    fg: theme().info,
                    bold: true
                  }, _$p));
                  return _el$190;
                })()] : goal().parentModel ? [(() => {
                  var _el$191 = _$createElement("span");
                  _$insertNode(_el$191, _$createTextNode(`\u21A9 `));
                  _$effect((_$p) => _$setProp(_el$191, "style", {
                    fg: theme().textMuted
                  }, _$p));
                  return _el$191;
                })(), (() => {
                  var _el$193 = _$createElement("span");
                  _$insert(_el$193, () => goal().parentModel);
                  _$effect((_$p) => _$setProp(_el$193, "style", {
                    fg: theme().info,
                    bold: true
                  }, _$p));
                  return _el$193;
                })(), (() => {
                  var _el$194 = _$createElement("span");
                  _$insertNode(_el$194, _$createTextNode(` (parent)`));
                  _$effect((_$p) => _$setProp(_el$194, "style", {
                    fg: theme().textMuted
                  }, _$p));
                  return _el$194;
                })()] : (() => {
                  var _el$196 = _$createElement("span");
                  _$insertNode(_el$196, _$createTextNode(`parent`));
                  _$effect((_$p) => _$setProp(_el$196, "style", {
                    fg: theme().textMuted
                  }, _$p));
                  return _el$196;
                })()), (() => {
                  var _el$167 = _$createElement("span");
                  _$insertNode(_el$167, _$createTextNode(` \u2502 \uD83D\uDCB0 `));
                  _$effect((_$p) => _$setProp(_el$167, "style", {
                    fg: theme().textMuted
                  }, _$p));
                  return _el$167;
                })(), (() => {
                  var _el$169 = _$createElement("span");
                  _$insertNode(_el$169, _$createTextNode(`Spent: `));
                  _$effect((_$p) => _$setProp(_el$169, "style", {
                    fg: theme().primary,
                    bold: true
                  }, _$p));
                  return _el$169;
                })(), (() => {
                  var _el$171 = _$createElement("span");
                  _$insert(_el$171, () => formatCost(goal().costUsed));
                  _$effect((_$p) => _$setProp(_el$171, "style", {
                    fg: theme().success,
                    bold: true
                  }, _$p));
                  return _el$171;
                })(), (() => {
                  var _el$172 = _$createElement("span");
                  _$insertNode(_el$172, _$createTextNode(` \xB7 `));
                  _$effect((_$p) => _$setProp(_el$172, "style", {
                    fg: theme().textMuted
                  }, _$p));
                  return _el$172;
                })(), (() => {
                  var _el$174 = _$createElement("span");
                  _$insert(_el$174, () => formatTokens(goal().tokensUsed));
                  _$effect((_$p) => _$setProp(_el$174, "style", {
                    fg: theme().warning,
                    bold: true
                  }, _$p));
                  return _el$174;
                })(), (() => {
                  var _el$175 = _$createElement("span"), _el$176 = _$createTextNode(` tokens \xB7 `);
                  _$insertNode(_el$175, _el$176);
                  _$insert(_el$175, () => formatDuration(goal().timeUsedSeconds), null);
                  _$effect((_$p) => _$setProp(_el$175, "style", {
                    fg: theme().textMuted
                  }, _$p));
                  return _el$175;
                })()];
              }, _el$142);
              _$insertNode(_el$143, _$createTextNode(`\uD83C\uDFAF Target: `));
              _$insert(_el$145, () => goal().objective.slice(0, 160));
              _$insert(_el$133, (() => {
                var _c$12 = _$memo(() => !!lp());
                return () => _c$12() && [(() => {
                  var _el$198 = _$createElement("span"), _el$199 = _$createTextNode(`
\u2714 `);
                  _$insertNode(_el$198, _el$199);
                  _$effect((_$p) => _$setProp(_el$198, "style", {
                    fg: theme().success
                  }, _$p));
                  return _el$198;
                })(), (() => {
                  var _el$201 = _$createElement("span");
                  _$insertNode(_el$201, _$createTextNode(`Progress: `));
                  _$effect((_$p) => _$setProp(_el$201, "style", {
                    fg: theme().success,
                    bold: true
                  }, _$p));
                  return _el$201;
                })(), (() => {
                  var _el$203 = _$createElement("span");
                  _$insert(_el$203, () => lp().summary.slice(0, 100));
                  _$effect((_$p) => _$setProp(_el$203, "style", {
                    fg: theme().text
                  }, _$p));
                  return _el$203;
                })(), (() => {
                  var _el$204 = _$createElement("span"), _el$205 = _$createTextNode(` \u2192 `);
                  _$insertNode(_el$204, _el$205);
                  _$insert(_el$204, () => lp().next?.slice(0, 60) || "", null);
                  _$effect((_$p) => _$setProp(_el$204, "style", {
                    fg: theme().textMuted
                  }, _$p));
                  return _el$204;
                })()];
              })(), null);
              _$insert(_el$133, (() => {
                var _c$13 = _$memo(() => !!blk());
                return () => _c$13() && [(() => {
                  var _el$206 = _$createElement("span"), _el$207 = _$createTextNode(`
\u2716 Blocked: `);
                  _$insertNode(_el$206, _el$207);
                  _$effect((_$p) => _$setProp(_el$206, "style", {
                    fg: theme().error,
                    bold: true
                  }, _$p));
                  return _el$206;
                })(), (() => {
                  var _el$209 = _$createElement("span");
                  _$insert(_el$209, () => blk().reason.slice(0, 140));
                  _$effect((_$p) => _$setProp(_el$209, "style", {
                    fg: theme().error
                  }, _$p));
                  return _el$209;
                })(), (() => {
                  var _el$210 = _$createElement("span"), _el$211 = _$createTextNode(` \u2014 `);
                  _$insertNode(_el$210, _el$211);
                  _$insert(_el$210, () => blk().needed.slice(0, 60), null);
                  _$effect((_$p) => _$setProp(_el$210, "style", {
                    fg: theme().textMuted
                  }, _$p));
                  return _el$210;
                })()];
              })(), null);
              _$insert(_el$133, (() => {
                var _c$14 = _$memo(() => !!goal().config.artifactDir);
                return () => _c$14() && [(() => {
                  var _el$212 = _$createElement("span"), _el$213 = _$createTextNode(`
\uD83D\uDCC1 `);
                  _$insertNode(_el$212, _el$213);
                  _$effect((_$p) => _$setProp(_el$212, "style", {
                    fg: theme().accent
                  }, _$p));
                  return _el$212;
                })(), (() => {
                  var _el$215 = _$createElement("span");
                  _$insertNode(_el$215, _$createTextNode(`Artifacts: `));
                  _$effect((_$p) => _$setProp(_el$215, "style", {
                    fg: theme().accent,
                    bold: true
                  }, _$p));
                  return _el$215;
                })(), (() => {
                  var _el$217 = _$createElement("span");
                  _$insert(_el$217, () => String(goal().config.artifactDir).replace(String(props.directory), "."));
                  _$effect((_$p) => _$setProp(_el$217, "style", {
                    fg: theme().textMuted
                  }, _$p));
                  return _el$217;
                })()];
              })(), null);
              _$insert(_el$133, (() => {
                var _c$15 = _$memo(() => !!goal().workerTopology);
                return () => _c$15() && [(() => {
                  var _el$218 = _$createElement("span"), _el$219 = _$createTextNode(`
\uD83C\uDF3F Worker: `);
                  _$insertNode(_el$218, _el$219);
                  _$effect((_$p) => _$setProp(_el$218, "style", {
                    fg: theme().textMuted
                  }, _$p));
                  return _el$218;
                })(), (() => {
                  var _el$221 = _$createElement("span");
                  _$insert(_el$221, (() => {
                    var _c$22 = _$memo(() => goal().workerTopology === "v2-native-child");
                    return () => _c$22() ? "native child" : goal().workerTopology === "v2-root-fallback" ? "root fallback" : "v1 child";
                  })());
                  _$effect((_$p) => _$setProp(_el$221, "style", {
                    fg: theme().text
                  }, _$p));
                  return _el$221;
                })(), _$memo(() => _$memo(() => !!goal().nativeParentID)() ? (() => {
                  var _el$222 = _$createElement("span"), _el$223 = _$createTextNode(` of `), _el$224 = _$createTextNode(`\u2026`);
                  _$insertNode(_el$222, _el$223);
                  _$insertNode(_el$222, _el$224);
                  _$insert(_el$222, () => goal().nativeParentID.slice(0, 12), _el$224);
                  _$effect((_$p) => _$setProp(_el$222, "style", {
                    fg: theme().textMuted
                  }, _$p));
                  return _el$222;
                })() : null)];
              })(), null);
              _$insert(_el$133, (() => {
                var _c$16 = _$memo(() => (goal().config.checks?.length ?? 0) > 0);
                return () => _c$16() ? [(() => {
                  var _el$225 = _$createElement("span"), _el$226 = _$createTextNode(`
\u25A3 `);
                  _$insertNode(_el$225, _el$226);
                  _$effect((_$p) => _$setProp(_el$225, "style", {
                    fg: theme().warning
                  }, _$p));
                  return _el$225;
                })(), (() => {
                  var _el$228 = _$createElement("span");
                  _$insertNode(_el$228, _$createTextNode(`Checks: `));
                  _$effect((_$p) => _$setProp(_el$228, "style", {
                    fg: theme().warning,
                    bold: true
                  }, _$p));
                  return _el$228;
                })(), (() => {
                  var _el$230 = _$createElement("span");
                  _$insert(_el$230, () => goal().config.checks.join(", ").slice(0, 100));
                  _$effect((_$p) => _$setProp(_el$230, "style", {
                    fg: theme().textMuted
                  }, _$p));
                  return _el$230;
                })()] : null;
              })(), null);
              _$insert(_el$133, (() => {
                var _c$17 = _$memo(() => rt()?.evaluatorRejectionCount > 0);
                return () => _c$17() && [(() => {
                  var _el$231 = _$createElement("span"), _el$232 = _$createTextNode(`
\u26A0 rejections: `);
                  _$insertNode(_el$231, _el$232);
                  _$effect((_$p) => _$setProp(_el$231, "style", {
                    fg: theme().warning
                  }, _$p));
                  return _el$231;
                })(), (() => {
                  var _el$234 = _$createElement("span"), _el$235 = _$createTextNode(` \u2014 `);
                  _$insertNode(_el$234, _el$235);
                  _$insert(_el$234, () => String(rt().evaluatorRejectionCount), _el$235);
                  _$insert(_el$234, () => String(rt().lastRejectionDetails || "").slice(0, 80), null);
                  _$effect((_$p) => _$setProp(_el$234, "style", {
                    fg: theme().warning
                  }, _$p));
                  return _el$234;
                })()];
              })(), null);
              _$insert(_el$133, (() => {
                var _c$18 = _$memo(() => rt()?.unknownStatusCount > 0);
                return () => _c$18() && [(() => {
                  var _el$236 = _$createElement("span"), _el$237 = _$createTextNode(`
\u26A0\uFE0F unreachable: `);
                  _$insertNode(_el$236, _el$237);
                  _$effect((_$p) => _$setProp(_el$236, "style", {
                    fg: theme().error
                  }, _$p));
                  return _el$236;
                })(), (() => {
                  var _el$239 = _$createElement("span"), _el$240 = _$createTextNode(`/3`);
                  _$insertNode(_el$239, _el$240);
                  _$insert(_el$239, () => String(rt().unknownStatusCount), _el$240);
                  _$effect((_$p) => _$setProp(_el$239, "style", {
                    fg: theme().error
                  }, _$p));
                  return _el$239;
                })(), (() => {
                  var _el$241 = _$createElement("span");
                  _$insertNode(_el$241, _$createTextNode(` \u2014 nudge to recover`));
                  _$effect((_$p) => _$setProp(_el$241, "style", {
                    fg: theme().textMuted
                  }, _$p));
                  return _el$241;
                })()];
              })(), null);
              _$insert(_el$133, (() => {
                var _c$19 = _$memo(() => !!rt()?.retryAfter);
                return () => _c$19() && [(() => {
                  var _el$243 = _$createElement("span"), _el$244 = _$createTextNode(`
\u21BB retry in: `);
                  _$insertNode(_el$243, _el$244);
                  _$effect((_$p) => _$setProp(_el$243, "style", {
                    fg: theme().accent
                  }, _$p));
                  return _el$243;
                })(), (() => {
                  var _el$246 = _$createElement("span");
                  _$insert(_el$246, () => countdownLabel(rt().retryAfter, clock()));
                  _$effect((_$p) => _$setProp(_el$246, "style", {
                    fg: theme().accent
                  }, _$p));
                  return _el$246;
                })()];
              })(), null);
              _$insert(_el$133, (() => {
                var _c$20 = _$memo(() => !!rt()?.nextRunAt);
                return () => _c$20() && [(() => {
                  var _el$247 = _$createElement("span"), _el$248 = _$createTextNode(`
\u23F0 next run: `);
                  _$insertNode(_el$247, _el$248);
                  _$effect((_$p) => _$setProp(_el$247, "style", {
                    fg: theme().accent
                  }, _$p));
                  return _el$247;
                })(), (() => {
                  var _el$250 = _$createElement("span");
                  _$insert(_el$250, () => countdownLabel(rt().nextRunAt, clock()));
                  _$effect((_$p) => _$setProp(_el$250, "style", {
                    fg: theme().accent
                  }, _$p));
                  return _el$250;
                })(), (() => {
                  var _el$251 = _$createElement("span"), _el$252 = _$createTextNode(` (`), _el$253 = _$createTextNode(` runs)`);
                  _$insertNode(_el$251, _el$252);
                  _$insertNode(_el$251, _el$253);
                  _$insert(_el$251, () => String(rt().scheduleRunCount || 0), _el$253);
                  _$effect((_$p) => _$setProp(_el$251, "style", {
                    fg: theme().textMuted
                  }, _$p));
                  return _el$251;
                })()];
              })(), null);
              _$insert(_el$133, (() => {
                var _c$21 = _$memo(() => !!rt()?.lastError);
                return () => _c$21() && [(() => {
                  var _el$254 = _$createElement("span"), _el$255 = _$createTextNode(`
\u26A0 `);
                  _$insertNode(_el$254, _el$255);
                  _$effect((_$p) => _$setProp(_el$254, "style", {
                    fg: theme().error
                  }, _$p));
                  return _el$254;
                })(), (() => {
                  var _el$257 = _$createElement("span");
                  _$insertNode(_el$257, _$createTextNode(`Error: `));
                  _$effect((_$p) => _$setProp(_el$257, "style", {
                    fg: theme().error,
                    bold: true
                  }, _$p));
                  return _el$257;
                })(), (() => {
                  var _el$259 = _$createElement("span");
                  _$insert(_el$259, () => rt().lastError.slice(0, 120));
                  _$effect((_$p) => _$setProp(_el$259, "style", {
                    fg: theme().error
                  }, _$p));
                  return _el$259;
                })()];
              })(), null);
              _$effect((_p$) => {
                var _v$42 = borderColorForStatus(goal().status, theme()), _v$43 = {
                  fg: statusColor(goal().status, theme()),
                  bold: true
                }, _v$44 = {
                  fg: theme().textMuted
                }, _v$45 = {
                  fg: statusColor(goal().status, theme())
                }, _v$46 = {
                  fg: theme().textMuted
                }, _v$47 = {
                  fg: theme().primary,
                  bold: true
                }, _v$48 = {
                  fg: theme().text
                };
                _v$42 !== _p$.e && (_p$.e = _$setProp(_el$132, "borderColor", _v$42, _p$.e));
                _v$43 !== _p$.t && (_p$.t = _$setProp(_el$134, "style", _v$43, _p$.t));
                _v$44 !== _p$.a && (_p$.a = _$setProp(_el$136, "style", _v$44, _p$.a));
                _v$45 !== _p$.o && (_p$.o = _$setProp(_el$138, "style", _v$45, _p$.o));
                _v$46 !== _p$.i && (_p$.i = _$setProp(_el$141, "style", _v$46, _p$.i));
                _v$47 !== _p$.n && (_p$.n = _$setProp(_el$143, "style", _v$47, _p$.n));
                _v$48 !== _p$.s && (_p$.s = _$setProp(_el$145, "style", _v$48, _p$.s));
                return _p$;
              }, {
                e: undefined,
                t: undefined,
                a: undefined,
                o: undefined,
                i: undefined,
                n: undefined,
                s: undefined
              });
              return _el$132;
            })();
          }
        })];
      }
    }), null);
    _$insert(_el$39, _$createComponent(Show, {
      get when() {
        return tab() === "commands";
      },
      get children() {
        return [_$createComponent(Show, {
          get when() {
            return ownerCommands().length > 0;
          },
          get fallback() {
            return (() => {
              var _el$260 = _$createElement("box"), _el$261 = _$createElement("text"), _el$262 = _$createElement("span"), _el$264 = _$createElement("span"), _el$266 = _$createElement("span"), _el$268 = _$createElement("text"), _el$269 = _$createElement("span"), _el$271 = _$createElement("span"), _el$273 = _$createElement("span"), _el$275 = _$createElement("span"), _el$277 = _$createElement("span");
              _$insertNode(_el$260, _el$261);
              _$insertNode(_el$260, _el$268);
              _$setProp(_el$260, "flexDirection", "column");
              _$setProp(_el$260, "gap", 1);
              _$setProp(_el$260, "padding", 1);
              _$insertNode(_el$261, _el$262);
              _$insertNode(_el$261, _el$264);
              _$insertNode(_el$261, _el$266);
              _$insertNode(_el$262, _$createTextNode(`No command sessions owned by this session. `));
              _$insertNode(_el$264, _$createTextNode(`:new &lt;command&gt;`));
              _$insertNode(_el$266, _$createTextNode(` to start one.`));
              _$insertNode(_el$268, _el$269);
              _$insertNode(_el$268, _el$271);
              _$insertNode(_el$268, _el$273);
              _$insertNode(_el$268, _el$275);
              _$insertNode(_el$268, _el$277);
              _$insertNode(_el$269, _$createTextNode(`Tip: `));
              _$insertNode(_el$271, _$createTextNode(`o`));
              _$insertNode(_el$273, _$createTextNode(` fullscreen \xB7 `));
              _$insertNode(_el$275, _$createTextNode(`:interrupt :terminate :remove`));
              _$insertNode(_el$277, _$createTextNode(` manage \xB7 text + Enter writes stdin.`));
              _$effect((_p$) => {
                var _v$49 = {
                  fg: theme().textMuted
                }, _v$50 = {
                  fg: theme().warning
                }, _v$51 = {
                  fg: theme().textMuted
                }, _v$52 = {
                  fg: theme().textMuted
                }, _v$53 = {
                  fg: theme().warning
                }, _v$54 = {
                  fg: theme().textMuted
                }, _v$55 = {
                  fg: theme().warning
                }, _v$56 = {
                  fg: theme().textMuted
                };
                _v$49 !== _p$.e && (_p$.e = _$setProp(_el$262, "style", _v$49, _p$.e));
                _v$50 !== _p$.t && (_p$.t = _$setProp(_el$264, "style", _v$50, _p$.t));
                _v$51 !== _p$.a && (_p$.a = _$setProp(_el$266, "style", _v$51, _p$.a));
                _v$52 !== _p$.o && (_p$.o = _$setProp(_el$269, "style", _v$52, _p$.o));
                _v$53 !== _p$.i && (_p$.i = _$setProp(_el$271, "style", _v$53, _p$.i));
                _v$54 !== _p$.n && (_p$.n = _$setProp(_el$273, "style", _v$54, _p$.n));
                _v$55 !== _p$.s && (_p$.s = _$setProp(_el$275, "style", _v$55, _p$.s));
                _v$56 !== _p$.h && (_p$.h = _$setProp(_el$277, "style", _v$56, _p$.h));
                return _p$;
              }, {
                e: undefined,
                t: undefined,
                a: undefined,
                o: undefined,
                i: undefined,
                n: undefined,
                s: undefined,
                h: undefined
              });
              return _el$260;
            })();
          },
          get children() {
            var _el$45 = _$createElement("scrollbox");
            _$insert(_el$45, _$createComponent(For, {
              get each() {
                return ownerCommands();
              },
              children: (cmd, i) => {
                const isActive = () => i() === cmdSelected();
                return (() => {
                  var _el$279 = _$createElement("box"), _el$280 = _$createElement("text"), _el$281 = _$createElement("span"), _el$282 = _$createElement("span"), _el$284 = _$createElement("span"), _el$286 = _$createElement("span"), _el$287 = _$createElement("span"), _el$289 = _$createElement("span"), _el$290 = _$createElement("span"), _el$291 = _$createTextNode(` \u2502 `);
                  _$insertNode(_el$279, _el$280);
                  _$setProp(_el$279, "flexDirection", "row");
                  _$setProp(_el$279, "paddingLeft", 1);
                  _$setProp(_el$279, "paddingRight", 1);
                  _$insertNode(_el$280, _el$281);
                  _$insertNode(_el$280, _el$282);
                  _$insertNode(_el$280, _el$284);
                  _$insertNode(_el$280, _el$286);
                  _$insertNode(_el$280, _el$287);
                  _$insertNode(_el$280, _el$289);
                  _$insertNode(_el$280, _el$290);
                  _$setProp(_el$280, "wrapMode", "none");
                  _$setProp(_el$280, "truncate", true);
                  _$insert(_el$281, (() => {
                    var _c$23 = _$memo(() => !!isActive());
                    return () => _c$23() ? `\u25B6 ${commandStatusIcon(cmd.status)} ${cmd.title}` : `  ${commandStatusIcon(cmd.status)} ${cmd.title}`;
                  })());
                  _$insertNode(_el$282, _$createTextNode(` \u2502 `));
                  _$insertNode(_el$284, _$createTextNode(`Cmd `));
                  _$insert(_el$286, () => commandStatusLabel(cmd.status).short);
                  _$insertNode(_el$287, _$createTextNode(` \u2502 `));
                  _$insert(_el$289, () => cmd.command);
                  _$insert(_el$280, (() => {
                    var _c$24 = _$memo(() => cmd.args.length > 0);
                    return () => _c$24() && (() => {
                      var _el$292 = _$createElement("span"), _el$293 = _$createTextNode(` `);
                      _$insertNode(_el$292, _el$293);
                      _$insert(_el$292, () => cmd.args.join(" ").slice(0, 40), null);
                      _$effect((_$p) => _$setProp(_el$292, "style", {
                        fg: theme().textMuted
                      }, _$p));
                      return _el$292;
                    })();
                  })(), _el$290);
                  _$insert(_el$280, (() => {
                    var _c$25 = _$memo(() => cmd.exitCode !== undefined);
                    return () => _c$25() && (() => {
                      var _el$294 = _$createElement("span"), _el$295 = _$createTextNode(` \u2502 exit `);
                      _$insertNode(_el$294, _el$295);
                      _$insert(_el$294, () => cmd.exitCode, null);
                      _$effect((_$p) => _$setProp(_el$294, "style", {
                        fg: cmd.exitCode === 0 ? theme().success : theme().error
                      }, _$p));
                      return _el$294;
                    })();
                  })(), _el$290);
                  _$insert(_el$280, (() => {
                    var _c$26 = _$memo(() => !!cmd.signal);
                    return () => _c$26() && (() => {
                      var _el$296 = _$createElement("span"), _el$297 = _$createTextNode(` \u2502 `);
                      _$insertNode(_el$296, _el$297);
                      _$insert(_el$296, () => cmd.signal, null);
                      _$effect((_$p) => _$setProp(_el$296, "style", {
                        fg: theme().warning
                      }, _$p));
                      return _el$296;
                    })();
                  })(), _el$290);
                  _$insertNode(_el$290, _el$291);
                  _$insert(_el$290, () => ageLabel(cmd.updatedAt, clock()), null);
                  _$insert(_el$280, (() => {
                    var _c$27 = _$memo(() => !!cmd.truncated);
                    return () => _c$27() && (() => {
                      var _el$298 = _$createElement("span");
                      _$insertNode(_el$298, _$createTextNode(` \u2502 \u26A0 truncated`));
                      _$effect((_$p) => _$setProp(_el$298, "style", {
                        fg: theme().warning,
                        bold: true
                      }, _$p));
                      return _el$298;
                    })();
                  })(), null);
                  _$effect((_p$) => {
                    var _v$57 = isActive() ? theme().backgroundElement : undefined, _v$58 = {
                      fg: commandStatusColor(cmd.status, theme()),
                      bold: isActive()
                    }, _v$59 = {
                      fg: theme().textMuted
                    }, _v$60 = {
                      fg: theme().textMuted
                    }, _v$61 = {
                      fg: commandStatusColor(cmd.status, theme()),
                      bold: true
                    }, _v$62 = {
                      fg: theme().textMuted
                    }, _v$63 = {
                      fg: theme().accent,
                      bold: true
                    }, _v$64 = {
                      fg: theme().textMuted
                    };
                    _v$57 !== _p$.e && (_p$.e = _$setProp(_el$279, "backgroundColor", _v$57, _p$.e));
                    _v$58 !== _p$.t && (_p$.t = _$setProp(_el$281, "style", _v$58, _p$.t));
                    _v$59 !== _p$.a && (_p$.a = _$setProp(_el$282, "style", _v$59, _p$.a));
                    _v$60 !== _p$.o && (_p$.o = _$setProp(_el$284, "style", _v$60, _p$.o));
                    _v$61 !== _p$.i && (_p$.i = _$setProp(_el$286, "style", _v$61, _p$.i));
                    _v$62 !== _p$.n && (_p$.n = _$setProp(_el$287, "style", _v$62, _p$.n));
                    _v$63 !== _p$.s && (_p$.s = _$setProp(_el$289, "style", _v$63, _p$.s));
                    _v$64 !== _p$.h && (_p$.h = _$setProp(_el$290, "style", _v$64, _p$.h));
                    return _p$;
                  }, {
                    e: undefined,
                    t: undefined,
                    a: undefined,
                    o: undefined,
                    i: undefined,
                    n: undefined,
                    s: undefined,
                    h: undefined
                  });
                  return _el$279;
                })();
              }
            }));
            _$effect((_$p) => _$setProp(_el$45, "height", Math.min(ownerCommands().length, 10), _$p));
            return _el$45;
          }
        }), _$createComponent(Show, {
          get when() {
            return selectedCommand();
          },
          children: (cmd) => (() => {
            var _el$300 = _$createElement("box"), _el$301 = _$createElement("text"), _el$302 = _$createElement("span"), _el$303 = _$createTextNode(` `), _el$304 = _$createElement("span"), _el$306 = _$createElement("span"), _el$307 = _$createTextNode(` \u2014 `), _el$308 = _$createTextNode(`
`), _el$309 = _$createElement("span"), _el$311 = _$createElement("span"), _el$312 = _$createTextNode(`
`), _el$313 = _$createElement("span"), _el$315 = _$createElement("span"), _el$317 = _$createElement("span"), _el$318 = _$createTextNode(`
`), _el$319 = _$createElement("span"), _el$321 = _$createElement("span"), _el$323 = _$createElement("span"), _el$324 = _$createTextNode(` bytes`), _el$325 = _$createElement("span"), _el$326 = _$createTextNode(` \u2502 updated `), _el$327 = _$createTextNode(`
`), _el$328 = _$createElement("span");
            _$insertNode(_el$300, _el$301);
            _$setProp(_el$300, "flexDirection", "column");
            _$setProp(_el$300, "border", true);
            _$setProp(_el$300, "padding", 1);
            _$setProp(_el$300, "flexShrink", 0);
            _$setProp(_el$300, "maxHeight", 8);
            _$insertNode(_el$301, _el$302);
            _$insertNode(_el$301, _el$304);
            _$insertNode(_el$301, _el$306);
            _$insertNode(_el$301, _el$308);
            _$insertNode(_el$301, _el$309);
            _$insertNode(_el$301, _el$311);
            _$insertNode(_el$301, _el$312);
            _$insertNode(_el$301, _el$313);
            _$insertNode(_el$301, _el$315);
            _$insertNode(_el$301, _el$317);
            _$insertNode(_el$301, _el$318);
            _$insertNode(_el$301, _el$319);
            _$insertNode(_el$301, _el$321);
            _$insertNode(_el$301, _el$323);
            _$insertNode(_el$301, _el$325);
            _$insertNode(_el$301, _el$327);
            _$insertNode(_el$301, _el$328);
            _$insertNode(_el$302, _el$303);
            _$insert(_el$302, () => commandStatusIcon(cmd().status), _el$303);
            _$insert(_el$302, () => cmd().title, null);
            _$insertNode(_el$304, _$createTextNode(` Cmd `));
            _$insertNode(_el$306, _el$307);
            _$insert(_el$306, () => commandStatusLabel(cmd().status).short, _el$307);
            _$insert(_el$306, () => commandStatusLabel(cmd().status).hint, null);
            _$insertNode(_el$309, _$createTextNode(`\u2B22 Spawn: `));
            _$insert(_el$311, () => cmd().command);
            _$insert(_el$301, (() => {
              var _c$28 = _$memo(() => cmd().args.length > 0);
              return () => _c$28() && (() => {
                var _el$330 = _$createElement("span"), _el$331 = _$createTextNode(` `);
                _$insertNode(_el$330, _el$331);
                _$insert(_el$330, () => cmd().args.join(" "), null);
                _$effect((_$p) => _$setProp(_el$330, "style", {
                  fg: theme().text
                }, _$p));
                return _el$330;
              })();
            })(), _el$312);
            _$insertNode(_el$313, _$createTextNode(`\uD83D\uDCC1 `));
            _$insertNode(_el$315, _$createTextNode(`Cwd: `));
            _$insert(_el$317, () => cmd().cwd.replace(String(props.directory), "."));
            _$insert(_el$301, (() => {
              var _c$29 = _$memo(() => !!cmd().goalID);
              return () => _c$29() && [(() => {
                var _el$332 = _$createElement("span");
                _$insertNode(_el$332, _$createTextNode(` \u2502 \uD83D\uDD17 linked goal `));
                _$effect((_$p) => _$setProp(_el$332, "style", {
                  fg: theme().textMuted
                }, _$p));
                return _el$332;
              })(), (() => {
                var _el$334 = _$createElement("span");
                _$insert(_el$334, () => cmd().goalID.slice(0, 8));
                _$effect((_$p) => _$setProp(_el$334, "style", {
                  fg: theme().text
                }, _$p));
                return _el$334;
              })()];
            })(), _el$318);
            _$insertNode(_el$319, _$createTextNode(`\uD83D\uDCBE `));
            _$insertNode(_el$321, _$createTextNode(`Output: `));
            _$insertNode(_el$323, _el$324);
            _$insert(_el$323, () => cmd().outputBytes, _el$324);
            _$insert(_el$301, (() => {
              var _c$30 = _$memo(() => !!cmd().truncated);
              return () => _c$30() && (() => {
                var _el$335 = _$createElement("span");
                _$insertNode(_el$335, _$createTextNode(` \xB7 \u26A0 truncated`));
                _$effect((_$p) => _$setProp(_el$335, "style", {
                  fg: theme().warning,
                  bold: true
                }, _$p));
                return _el$335;
              })();
            })(), _el$325);
            _$insertNode(_el$325, _el$326);
            _$insert(_el$325, () => ageLabel(cmd().updatedAt, clock()), null);
            _$insert(_el$301, (() => {
              var _c$31 = _$memo(() => !!cmd().lastError);
              return () => _c$31() && [(() => {
                var _el$337 = _$createElement("span"), _el$338 = _$createTextNode(`
\u26A0 Error: `);
                _$insertNode(_el$337, _el$338);
                _$effect((_$p) => _$setProp(_el$337, "style", {
                  fg: theme().error,
                  bold: true
                }, _$p));
                return _el$337;
              })(), (() => {
                var _el$340 = _$createElement("span");
                _$insert(_el$340, () => cmd().lastError.slice(0, 120));
                _$effect((_$p) => _$setProp(_el$340, "style", {
                  fg: theme().error
                }, _$p));
                return _el$340;
              })()];
            })(), _el$327);
            _$insertNode(_el$328, _$createTextNode(`o fullscreen \xB7 :interrupt :terminate :remove \xB7 text + Enter writes stdin`));
            _$effect((_p$) => {
              var _v$65 = commandBorderColor(cmd().status, theme()), _v$66 = {
                fg: commandStatusColor(cmd().status, theme()),
                bold: true
              }, _v$67 = {
                fg: theme().textMuted
              }, _v$68 = {
                fg: commandStatusColor(cmd().status, theme())
              }, _v$69 = {
                fg: theme().primary,
                bold: true
              }, _v$70 = {
                fg: theme().accent,
                bold: true
              }, _v$71 = {
                fg: theme().textMuted
              }, _v$72 = {
                fg: theme().accent,
                bold: true
              }, _v$73 = {
                fg: theme().textMuted
              }, _v$74 = {
                fg: theme().warning,
                bold: true
              }, _v$75 = {
                fg: theme().warning,
                bold: true
              }, _v$76 = {
                fg: theme().text
              }, _v$77 = {
                fg: theme().textMuted
              }, _v$78 = {
                fg: theme().textMuted
              };
              _v$65 !== _p$.e && (_p$.e = _$setProp(_el$300, "borderColor", _v$65, _p$.e));
              _v$66 !== _p$.t && (_p$.t = _$setProp(_el$302, "style", _v$66, _p$.t));
              _v$67 !== _p$.a && (_p$.a = _$setProp(_el$304, "style", _v$67, _p$.a));
              _v$68 !== _p$.o && (_p$.o = _$setProp(_el$306, "style", _v$68, _p$.o));
              _v$69 !== _p$.i && (_p$.i = _$setProp(_el$309, "style", _v$69, _p$.i));
              _v$70 !== _p$.n && (_p$.n = _$setProp(_el$311, "style", _v$70, _p$.n));
              _v$71 !== _p$.s && (_p$.s = _$setProp(_el$313, "style", _v$71, _p$.s));
              _v$72 !== _p$.h && (_p$.h = _$setProp(_el$315, "style", _v$72, _p$.h));
              _v$73 !== _p$.r && (_p$.r = _$setProp(_el$317, "style", _v$73, _p$.r));
              _v$74 !== _p$.d && (_p$.d = _$setProp(_el$319, "style", _v$74, _p$.d));
              _v$75 !== _p$.l && (_p$.l = _$setProp(_el$321, "style", _v$75, _p$.l));
              _v$76 !== _p$.u && (_p$.u = _$setProp(_el$323, "style", _v$76, _p$.u));
              _v$77 !== _p$.c && (_p$.c = _$setProp(_el$325, "style", _v$77, _p$.c));
              _v$78 !== _p$.w && (_p$.w = _$setProp(_el$328, "style", _v$78, _p$.w));
              return _p$;
            }, {
              e: undefined,
              t: undefined,
              a: undefined,
              o: undefined,
              i: undefined,
              n: undefined,
              s: undefined,
              h: undefined,
              r: undefined,
              d: undefined,
              l: undefined,
              u: undefined,
              c: undefined,
              w: undefined
            });
            return _el$300;
          })()
        })];
      }
    }), null);
    _$insert(_el$39, _$createComponent(Show, {
      get when() {
        return _$memo(() => !!showLogs())() && events().length > 0;
      },
      get children() {
        var _el$46 = _$createElement("box"), _el$47 = _$createElement("text"), _el$48 = _$createElement("span"), _el$50 = _$createElement("span");
        _$insertNode(_el$46, _el$47);
        _$setProp(_el$46, "flexDirection", "column");
        _$setProp(_el$46, "border", true);
        _$setProp(_el$46, "padding", 1);
        _$setProp(_el$46, "maxHeight", 7);
        _$setProp(_el$46, "flexShrink", 0);
        _$setProp(_el$46, "overflow", "hidden");
        _$insertNode(_el$47, _el$48);
        _$insertNode(_el$47, _el$50);
        _$insertNode(_el$48, _$createTextNode(`\u25C8 Recent Events`));
        _$insertNode(_el$50, _$createTextNode(` \u2014 :logs to hide`));
        _$insert(_el$47, _$createComponent(For, {
          get each() {
            return events().slice(-10);
          },
          children: (ev) => [`
`, (() => {
            var _el$341 = _$createElement("span");
            _$insert(_el$341, () => String(ev.type));
            _$effect((_$p) => _$setProp(_el$341, "style", {
              fg: eventColor(String(ev.type), theme()),
              bold: true
            }, _$p));
            return _el$341;
          })(), (() => {
            var _el$342 = _$createElement("span"), _el$343 = _$createTextNode(` `);
            _$insertNode(_el$342, _el$343);
            _$insert(_el$342, () => ev.goalID?.slice(0, 8), null);
            _$effect((_$p) => _$setProp(_el$342, "style", {
              fg: theme().textMuted
            }, _$p));
            return _el$342;
          })(), _$memo(() => _$memo(() => !!ev.summary)() && (() => {
            var _el$344 = _$createElement("span"), _el$345 = _$createTextNode(` \u2014 `);
            _$insertNode(_el$344, _el$345);
            _$insert(_el$344, () => String(ev.summary).slice(0, 60), null);
            _$effect((_$p) => _$setProp(_el$344, "style", {
              fg: theme().text
            }, _$p));
            return _el$344;
          })())]
        }), null);
        _$effect((_p$) => {
          var _v$ = theme().border, _v$2 = {
            fg: theme().accent,
            bold: true
          }, _v$3 = {
            fg: theme().textMuted
          };
          _v$ !== _p$.e && (_p$.e = _$setProp(_el$46, "borderColor", _v$, _p$.e));
          _v$2 !== _p$.t && (_p$.t = _$setProp(_el$48, "style", _v$2, _p$.t));
          _v$3 !== _p$.a && (_p$.a = _$setProp(_el$50, "style", _v$3, _p$.a));
          return _p$;
        }, {
          e: undefined,
          t: undefined,
          a: undefined
        });
        return _el$46;
      }
    }), null);
    _$insertNode(_el$52, _el$53);
    _$insertNode(_el$52, _el$55);
    _$setProp(_el$52, "flexDirection", "row");
    _$setProp(_el$52, "border", true);
    _$setProp(_el$52, "paddingLeft", 1);
    _$setProp(_el$52, "paddingRight", 1);
    _$setProp(_el$52, "flexShrink", 0);
    _$setProp(_el$52, "height", 3);
    _$setProp(_el$52, "gap", 1);
    _$insertNode(_el$53, _el$54);
    _$insert(_el$54, () => mode() === "insert" ? " INSERT \uE0B1" : " NORMAL ");
    _$use((el) => {
      inputEl = el;
      focusInput();
    }, _el$55);
    _$setProp(_el$55, "flexGrow", 1);
    _$setProp(_el$55, "onInput", (v) => {
      debugLog("onInput", JSON.stringify(v), "mode", mode());
      if (mode() === "insert")
        setCommandInput(v);
      else if (inputEl?.value)
        inputEl.value = "";
    });
    _$setProp(_el$55, "onKeyDown", (evt) => {
      const name = evt.name || "";
      const seq = evt.sequence || "";
      debugLog("input onKeyDown", `name=${name} seq=${JSON.stringify(seq)} mode=${mode()} value=${JSON.stringify(commandInput())}`);
      if (mode() !== "insert") {
        if ((evt.name || "").length === 1)
          prevent(evt);
        return;
      }
    });
    _$effect((_p$) => {
      var _v$4 = theme().border, _v$5 = {
        fg: theme().primary,
        bold: true
      }, _v$6 = {
        fg: theme().textMuted
      }, _v$7 = {
        fg: mode() === "normal" ? theme().success : theme().warning,
        bold: true,
        bg: mode() === "insert" ? theme().backgroundElement : undefined
      }, _v$8 = {
        fg: theme().textMuted
      }, _v$9 = {
        fg: theme().accent,
        bold: true
      }, _v$0 = {
        fg: theme().textMuted
      }, _v$1 = {
        fg: theme().textMuted
      }, _v$10 = {
        fg: runningCount() > 0 ? theme().success : theme().textMuted,
        bold: runningCount() > 0
      }, _v$11 = {
        fg: theme().textMuted
      }, _v$12 = {
        fg: theme().info,
        bold: true
      }, _v$13 = {
        fg: theme().textMuted
      }, _v$14 = {
        fg: theme().textMuted
      }, _v$15 = {
        fg: tab() === "goals" ? theme().primary : theme().textMuted,
        bold: tab() === "goals"
      }, _v$16 = {
        fg: theme().textMuted
      }, _v$17 = {
        fg: tab() === "commands" ? theme().primary : theme().textMuted,
        bold: tab() === "commands"
      }, _v$18 = {
        fg: theme().textMuted
      }, _v$19 = mode() === "insert" ? theme().warning : theme().border, _v$20 = {
        fg: mode() === "insert" ? theme().warning : theme().success,
        bold: true,
        bg: mode() === "insert" ? theme().backgroundElement : undefined
      }, _v$21 = mode() === "insert" ? ":send hello  or  :force done --evidence proof  or  :open  (Ctrl+N: normal)" : statusText() || "Press : to send/command  \xB7  ? help  \xB7  o open child  \xB7  q close", _v$22 = theme().textMuted, _v$23 = theme().primary, _v$24 = theme().text, _v$25 = theme().background;
      _v$4 !== _p$.e && (_p$.e = _$setProp(_el$2, "borderColor", _v$4, _p$.e));
      _v$5 !== _p$.t && (_p$.t = _$setProp(_el$5, "style", _v$5, _p$.t));
      _v$6 !== _p$.a && (_p$.a = _$setProp(_el$7, "style", _v$6, _p$.a));
      _v$7 !== _p$.o && (_p$.o = _$setProp(_el$9, "style", _v$7, _p$.o));
      _v$8 !== _p$.i && (_p$.i = _$setProp(_el$10, "style", _v$8, _p$.i));
      _v$9 !== _p$.n && (_p$.n = _$setProp(_el$12, "style", _v$9, _p$.n));
      _v$0 !== _p$.s && (_p$.s = _$setProp(_el$13, "style", _v$0, _p$.s));
      _v$1 !== _p$.h && (_p$.h = _$setProp(_el$15, "style", _v$1, _p$.h));
      _v$10 !== _p$.r && (_p$.r = _$setProp(_el$17, "style", _v$10, _p$.r));
      _v$11 !== _p$.d && (_p$.d = _$setProp(_el$20, "style", _v$11, _p$.d));
      _v$12 !== _p$.l && (_p$.l = _$setProp(_el$22, "style", _v$12, _p$.l));
      _v$13 !== _p$.u && (_p$.u = _$setProp(_el$23, "style", _v$13, _p$.u));
      _v$14 !== _p$.c && (_p$.c = _$setProp(_el$25, "style", _v$14, _p$.c));
      _v$15 !== _p$.w && (_p$.w = _$setProp(_el$27, "style", _v$15, _p$.w));
      _v$16 !== _p$.m && (_p$.m = _$setProp(_el$29, "style", _v$16, _p$.m));
      _v$17 !== _p$.f && (_p$.f = _$setProp(_el$31, "style", _v$17, _p$.f));
      _v$18 !== _p$.y && (_p$.y = _$setProp(_el$33, "style", _v$18, _p$.y));
      _v$19 !== _p$.g && (_p$.g = _$setProp(_el$52, "borderColor", _v$19, _p$.g));
      _v$20 !== _p$.p && (_p$.p = _$setProp(_el$54, "style", _v$20, _p$.p));
      _v$21 !== _p$.b && (_p$.b = _$setProp(_el$55, "placeholder", _v$21, _p$.b));
      _v$22 !== _p$.T && (_p$.T = _$setProp(_el$55, "placeholderColor", _v$22, _p$.T));
      _v$23 !== _p$.A && (_p$.A = _$setProp(_el$55, "cursorColor", _v$23, _p$.A));
      _v$24 !== _p$.O && (_p$.O = _$setProp(_el$55, "focusedTextColor", _v$24, _p$.O));
      _v$25 !== _p$.I && (_p$.I = _$setProp(_el$55, "focusedBackgroundColor", _v$25, _p$.I));
      return _p$;
    }, {
      e: undefined,
      t: undefined,
      a: undefined,
      o: undefined,
      i: undefined,
      n: undefined,
      s: undefined,
      h: undefined,
      r: undefined,
      d: undefined,
      l: undefined,
      u: undefined,
      c: undefined,
      w: undefined,
      m: undefined,
      f: undefined,
      y: undefined,
      g: undefined,
      p: undefined,
      b: undefined,
      T: undefined,
      A: undefined,
      O: undefined,
      I: undefined
    });
    return _el$;
  })();
}

// src/tui/command-panel.tsx
import { effect as _$effect2 } from "@opentui/solid";
import { use as _$use2 } from "@opentui/solid";
import { createComponent as _$createComponent2 } from "@opentui/solid";
import { insert as _$insert2 } from "@opentui/solid";
import { memo as _$memo2 } from "@opentui/solid";
import { createTextNode as _$createTextNode2 } from "@opentui/solid";
import { insertNode as _$insertNode2 } from "@opentui/solid";
import { setProp as _$setProp2 } from "@opentui/solid";
import { createElement as _$createElement2 } from "@opentui/solid";
import { createSignal as createSignal2, For as For2, Show as Show2, onCleanup as onCleanup2, onMount as onMount2 } from "solid-js";
import { useKeyboard as useKeyboard2 } from "@opentui/solid";

// src/tui/command-stream-client.ts
import { promises as fs2 } from "fs";
import path2 from "path";

// src/domain/command-events.ts
var _encoder = new TextEncoder;
function utf8ByteLength(data) {
  return _encoder.encode(data).length;
}
function offsetsContinuous(prevEnd, nextStart) {
  return prevEnd === nextStart;
}
function expectedNextEnd(startOffset, data) {
  return startOffset + utf8ByteLength(data);
}
var VALID_STATUSES = [
  "running",
  "exited",
  "terminated",
  "missing"
];
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isNonEmptyString2(value) {
  return typeof value === "string" && value.length > 0;
}
function isNonNegativeInt(value) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}
function isCommandSessionLike(value) {
  if (!isRecord(value))
    return false;
  if (typeof value["id"] !== "string" || value["id"].length === 0)
    return false;
  if (typeof value["title"] !== "string")
    return false;
  if (typeof value["command"] !== "string")
    return false;
  if (typeof value["cwd"] !== "string")
    return false;
  if (typeof value["ownerSessionID"] !== "string")
    return false;
  if (typeof value["status"] !== "string")
    return false;
  if (!VALID_STATUSES.includes(value["status"]))
    return false;
  if (!isNonNegativeInt(value["outputBytes"]))
    return false;
  if (typeof value["truncated"] !== "boolean")
    return false;
  if (typeof value["createdAt"] !== "string")
    return false;
  if (typeof value["updatedAt"] !== "string")
    return false;
  if (value["args"] !== undefined && !Array.isArray(value["args"]))
    return false;
  if (value["streamBytes"] !== undefined && !isNonNegativeInt(value["streamBytes"]))
    return false;
  return true;
}
function checkOffsets(startOffset, endOffset, data) {
  if (typeof data !== "string")
    return "data must be a string";
  if (!isNonNegativeInt(startOffset))
    return "startOffset must be a non-negative integer";
  if (!isNonNegativeInt(endOffset))
    return "endOffset must be a non-negative integer";
  if (endOffset < startOffset)
    return "endOffset must be >= startOffset";
  const expected = expectedNextEnd(startOffset, data);
  if (endOffset !== expected)
    return `endOffset mismatch: expected ${expected} (startOffset + UTF-8 byte length ${expected - startOffset}), got ${endOffset}`;
  return null;
}
function validateCommandStreamMessage(value) {
  try {
    if (!isRecord(value))
      return { ok: false, error: "message must be an object" };
    const type = value["type"];
    if (typeof type !== "string")
      return { ok: false, error: "missing type field" };
    switch (type) {
      case "subscribe": {
        if (!isNonEmptyString2(value["commandID"]))
          return { ok: false, error: "subscribe.commandID must be a non-empty string" };
        if (!isNonEmptyString2(value["ownerSessionID"]))
          return { ok: false, error: "subscribe.ownerSessionID must be a non-empty string" };
        return {
          ok: true,
          message: {
            type: "subscribe",
            commandID: value["commandID"],
            ownerSessionID: value["ownerSessionID"]
          }
        };
      }
      case "snapshot": {
        if (!isCommandSessionLike(value["command"]))
          return { ok: false, error: "snapshot.command must be CommandSession metadata" };
        const offsetError = checkOffsets(value["startOffset"], value["endOffset"], value["data"]);
        if (offsetError)
          return { ok: false, error: `snapshot.${offsetError}` };
        return {
          ok: true,
          message: {
            type: "snapshot",
            command: value["command"],
            data: value["data"],
            startOffset: value["startOffset"],
            endOffset: value["endOffset"]
          }
        };
      }
      case "output": {
        if (!isNonEmptyString2(value["commandID"]))
          return { ok: false, error: "output.commandID must be a non-empty string" };
        const offsetError = checkOffsets(value["startOffset"], value["endOffset"], value["data"]);
        if (offsetError)
          return { ok: false, error: `output.${offsetError}` };
        return {
          ok: true,
          message: {
            type: "output",
            commandID: value["commandID"],
            data: value["data"],
            startOffset: value["startOffset"],
            endOffset: value["endOffset"]
          }
        };
      }
      case "status": {
        if (!isCommandSessionLike(value["command"]))
          return { ok: false, error: "status.command must be CommandSession metadata" };
        return { ok: true, message: { type: "status", command: value["command"] } };
      }
      case "input": {
        if (!isNonEmptyString2(value["commandID"]))
          return { ok: false, error: "input.commandID must be a non-empty string" };
        if (typeof value["data"] !== "string")
          return { ok: false, error: "input.data must be a string" };
        return {
          ok: true,
          message: { type: "input", commandID: value["commandID"], data: value["data"] }
        };
      }
      case "interrupt": {
        if (!isNonEmptyString2(value["commandID"]))
          return { ok: false, error: "interrupt.commandID must be a non-empty string" };
        return { ok: true, message: { type: "interrupt", commandID: value["commandID"] } };
      }
      case "resync": {
        if (!isNonEmptyString2(value["commandID"]))
          return { ok: false, error: "resync.commandID must be a non-empty string" };
        return { ok: true, message: { type: "resync", commandID: value["commandID"] } };
      }
      case "unsubscribe": {
        if (!isNonEmptyString2(value["commandID"]))
          return { ok: false, error: "unsubscribe.commandID must be a non-empty string" };
        return { ok: true, message: { type: "unsubscribe", commandID: value["commandID"] } };
      }
      case "error": {
        if (!isNonEmptyString2(value["code"]))
          return { ok: false, error: "error.code must be a non-empty string" };
        if (typeof value["message"] !== "string")
          return { ok: false, error: "error.message must be a string" };
        return {
          ok: true,
          message: { type: "error", code: value["code"], message: value["message"] }
        };
      }
      default:
        return { ok: false, error: `unknown message type: ${type}` };
    }
  } catch (err) {
    return { ok: false, error: `validation failed: ${String(err)}` };
  }
}

// src/tui/command-stream-client.ts
function defaultEndpointPath(directory) {
  return path2.join(directory, ".opencode", "loopd", "commands", ".stream-endpoint.json");
}
async function defaultReadEndpoint(directory) {
  let text;
  try {
    text = await fs2.readFile(defaultEndpointPath(directory), "utf8");
  } catch {
    return;
  }
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed.url !== "string" || parsed.url.length === 0)
      return;
    return { url: parsed.url };
  } catch {
    return;
  }
}
function defaultCreateSocket(url) {
  const ws = new WebSocket(url);
  const socket = {
    send: (data) => ws.send(data),
    close: (code, reason) => ws.close(code, reason),
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null
  };
  ws.onopen = () => socket.onopen?.();
  ws.onmessage = (ev) => socket.onmessage?.(String(ev.data));
  ws.onclose = (ev) => socket.onclose?.(ev.code, ev.reason);
  ws.onerror = (err) => socket.onerror?.(err);
  return socket;
}
function createCommandStreamClient(options = {}) {
  const readEndpoint = options.readEndpoint ?? defaultReadEndpoint;
  const createSocket = options.createSocket ?? defaultCreateSocket;
  const initialBackoffMs = options.initialBackoffMs ?? 250;
  const maxBackoffMs = options.maxBackoffMs ?? 8000;
  const maxResyncsPerWindow = options.maxResyncsPerWindow ?? 5;
  const resyncWindowMs = options.resyncWindowMs ?? 30000;
  const snapshotTimeoutMs = options.snapshotTimeoutMs ?? 8000;
  const maxPreSnapshotBuffered = options.maxPreSnapshotBuffered ?? 32;
  let state = "disconnected";
  let directory = "";
  let endpointURL = "";
  let socket;
  let generation = 0;
  let closedIntentionally = false;
  let reconnectAttempt = 0;
  let reconnectTimer;
  const subs = new Map;
  function emitConnection(next) {
    if (state === next)
      return;
    state = next;
    try {
      options.onConnection?.(next);
    } catch {}
    for (const sub of subs.values()) {
      try {
        sub.handlers.onConnection?.(next);
      } catch {}
    }
  }
  function sendWire(msg) {
    if (!socket || state !== "connected")
      return false;
    try {
      socket.send(JSON.stringify(msg));
      return true;
    } catch {
      return false;
    }
  }
  function sendSubscribe(sub) {
    return sendWire({ type: "subscribe", commandID: sub.commandID, ownerSessionID: sub.ownerSessionID });
  }
  function clearSnapshotTimer(sub) {
    if (sub.snapshotTimer) {
      clearTimeout(sub.snapshotTimer);
      sub.snapshotTimer = undefined;
    }
  }
  function armSnapshotTimer(sub) {
    clearSnapshotTimer(sub);
    if (sub.hasSnapshot)
      return;
    sub.snapshotTimer = setTimeout(() => {
      sub.snapshotTimer = undefined;
      if (sub.hasSnapshot || !subs.has(sub.commandID))
        return;
      sub.resyncPending = false;
      try {
        sub.handlers.onError?.(`snapshot-timeout: no snapshot for ${sub.commandID} within ${snapshotTimeoutMs}ms \u2014 using polling fallback`);
      } catch {}
    }, snapshotTimeoutMs);
    const t = sub.snapshotTimer;
    try {
      t.unref?.();
    } catch {}
  }
  function pruneResyncTimes(sub, now) {
    sub.resyncTimes = sub.resyncTimes.filter((t) => now - t < resyncWindowMs);
  }
  function requestResync(sub, reason) {
    if (sub.resyncPending)
      return;
    const now = Date.now();
    pruneResyncTimes(sub, now);
    if (sub.resyncTimes.length >= maxResyncsPerWindow) {
      try {
        sub.handlers.onError?.(`resync-loop-guard: giving up after ${sub.resyncTimes.length} resyncs (${reason})`);
      } catch {}
      return;
    }
    sub.resyncTimes.push(now);
    sub.resyncPending = true;
    if (!sendSubscribe(sub)) {
      return;
    }
  }
  function handleMessage(raw) {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    let validated;
    try {
      validated = validateCommandStreamMessage(parsed);
    } catch {
      return;
    }
    if (!validated.ok)
      return;
    const msg = validated.message;
    switch (msg.type) {
      case "snapshot": {
        const id = msg.command.id;
        const sub = subs.get(id);
        if (!sub)
          return;
        sub.startOffset = msg.startOffset;
        sub.endOffset = msg.endOffset;
        sub.resyncPending = false;
        sub.hasSnapshot = true;
        sub.preSnapshotDropped = 0;
        clearSnapshotTimer(sub);
        try {
          sub.handlers.onSnapshot?.({
            command: msg.command,
            data: msg.data,
            startOffset: msg.startOffset,
            endOffset: msg.endOffset
          });
        } catch {}
        break;
      }
      case "output": {
        const sub = subs.get(msg.commandID);
        if (!sub)
          return;
        if (sub.endOffset === undefined || !sub.hasSnapshot) {
          sub.preSnapshotDropped += 1;
          if (sub.preSnapshotDropped <= maxPreSnapshotBuffered) {
            requestResync(sub, "no-baseline");
          }
          return;
        }
        if (offsetsContinuous(sub.endOffset, msg.startOffset)) {
          sub.endOffset = msg.endOffset;
          try {
            sub.handlers.onDelta?.({
              commandID: msg.commandID,
              data: msg.data,
              startOffset: msg.startOffset,
              endOffset: msg.endOffset
            });
          } catch {}
        } else {
          requestResync(sub, msg.startOffset > sub.endOffset ? "gap" : "overlap");
        }
        break;
      }
      case "status": {
        const id = msg.command.id;
        const sub = subs.get(id);
        if (!sub)
          return;
        try {
          sub.handlers.onStatus?.(msg.command);
        } catch {}
        break;
      }
      case "error": {
        const text = `${msg.code}: ${msg.message}`;
        for (const sub of subs.values()) {
          try {
            sub.handlers.onError?.(text);
          } catch {}
        }
        break;
      }
      default:
        break;
    }
  }
  function openSocket() {
    if (!endpointURL)
      return false;
    closedIntentionally = false;
    generation += 1;
    const myGeneration = generation;
    emitConnection("connecting");
    let next;
    try {
      next = createSocket(endpointURL);
    } catch {
      scheduleReconnect();
      return false;
    }
    socket = next;
    socket.onopen = () => {
      if (myGeneration !== generation || socket !== next)
        return;
      reconnectAttempt = 0;
      emitConnection("connected");
      if (directory) {
        readEndpoint(directory).then((ep) => {
          if (myGeneration !== generation)
            return;
          if (ep && typeof ep.url === "string" && ep.url.length > 0)
            endpointURL = ep.url;
        }, () => {});
      }
      for (const sub of subs.values()) {
        sub.resyncPending = false;
        sub.hasSnapshot = false;
        sub.endOffset = undefined;
        sub.startOffset = undefined;
        sub.preSnapshotDropped = 0;
        sendSubscribe(sub);
        armSnapshotTimer(sub);
      }
    };
    socket.onmessage = (data) => {
      if (myGeneration !== generation || socket !== next)
        return;
      handleMessage(data);
    };
    socket.onclose = () => {
      if (myGeneration !== generation || socket !== next)
        return;
      socket = undefined;
      for (const sub of subs.values()) {
        sub.hasSnapshot = false;
        sub.endOffset = undefined;
        sub.startOffset = undefined;
        sub.resyncPending = false;
        clearSnapshotTimer(sub);
      }
      if (closedIntentionally) {
        emitConnection("disconnected");
        return;
      }
      emitConnection("disconnected");
      scheduleReconnect();
    };
    socket.onerror = () => {};
    return true;
  }
  function scheduleReconnect() {
    if (closedIntentionally)
      return;
    if (reconnectTimer)
      return;
    const delay = Math.min(initialBackoffMs * 2 ** reconnectAttempt, maxBackoffMs);
    reconnectAttempt += 1;
    emitConnection("connecting");
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      if (closedIntentionally || !directory)
        return;
      readEndpoint(directory).then((ep) => {
        if (closedIntentionally || !directory)
          return;
        if (ep && typeof ep.url === "string" && ep.url.length > 0)
          endpointURL = ep.url;
        if (!endpointURL) {
          scheduleReconnect();
          return;
        }
        openSocket();
      }, () => {
        if (!endpointURL) {
          scheduleReconnect();
          return;
        }
        openSocket();
      });
    }, delay);
    const t = reconnectTimer;
    try {
      t.unref?.();
    } catch {}
  }
  return {
    get connectionState() {
      return state;
    },
    async connect(nextDirectory) {
      directory = nextDirectory;
      let endpoint;
      try {
        endpoint = await readEndpoint(nextDirectory);
      } catch {
        return { ok: false, reason: "no-endpoint" };
      }
      if (!endpoint || typeof endpoint.url !== "string" || endpoint.url.length === 0) {
        return { ok: false, reason: "no-endpoint" };
      }
      if (endpointURL === endpoint.url && socket && (state === "connected" || state === "connecting")) {
        return { ok: true };
      }
      try {
        socket?.close(1000, "reconnect");
      } catch {}
      socket = undefined;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = undefined;
      }
      reconnectAttempt = 0;
      endpointURL = endpoint.url;
      const opened = openSocket();
      if (!opened)
        return { ok: false, reason: "connect-failed" };
      return { ok: true };
    },
    subscribe(commandID, ownerSessionID, handlers = {}) {
      if (!commandID || !ownerSessionID)
        return { ok: false, reason: "owner-required" };
      let sub = subs.get(commandID);
      if (!sub) {
        sub = {
          commandID,
          ownerSessionID,
          handlers,
          endOffset: undefined,
          startOffset: undefined,
          hasSnapshot: false,
          resyncPending: false,
          resyncTimes: [],
          preSnapshotDropped: 0,
          snapshotTimer: undefined
        };
        subs.set(commandID, sub);
      } else {
        sub.ownerSessionID = ownerSessionID;
        sub.handlers = handlers;
        sub.endOffset = undefined;
        sub.startOffset = undefined;
        sub.hasSnapshot = false;
        sub.resyncPending = false;
        sub.preSnapshotDropped = 0;
        clearSnapshotTimer(sub);
      }
      if (!socket || state !== "connected") {
        return { ok: true };
      }
      const sent = sendSubscribe(sub);
      if (sent)
        armSnapshotTimer(sub);
      return sent ? { ok: true } : { ok: false, reason: "send-failed" };
    },
    unsubscribe(commandID) {
      const sub = subs.get(commandID);
      if (sub)
        clearSnapshotTimer(sub);
      subs.delete(commandID);
      if (sub && socket && state === "connected") {
        try {
          socket.send(JSON.stringify({ type: "unsubscribe", commandID }));
        } catch {}
      }
    },
    sendInput(commandID, data) {
      const sub = subs.get(commandID);
      if (!socket || state !== "connected" || !sub || !sub.hasSnapshot) {
        return { ok: false, reason: "not-subscribed" };
      }
      return sendWire({ type: "input", commandID, data }) ? { ok: true } : { ok: false, reason: "send-failed" };
    },
    sendInterrupt(commandID) {
      const sub = subs.get(commandID);
      if (!socket || state !== "connected" || !sub || !sub.hasSnapshot) {
        return { ok: false, reason: "not-subscribed" };
      }
      return sendWire({ type: "interrupt", commandID }) ? { ok: true } : { ok: false, reason: "send-failed" };
    },
    isLive(commandID) {
      return state === "connected" && subs.get(commandID)?.hasSnapshot === true;
    },
    disconnect() {
      closedIntentionally = true;
      generation += 1;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = undefined;
      }
      for (const sub of subs.values()) {
        clearSnapshotTimer(sub);
        sub.hasSnapshot = false;
        sub.endOffset = undefined;
        sub.startOffset = undefined;
        sub.resyncPending = false;
      }
      try {
        socket?.close(1000, "client disconnect");
      } catch {}
      socket = undefined;
      emitConnection("disconnected");
    },
    dispose() {
      for (const sub of subs.values())
        clearSnapshotTimer(sub);
      subs.clear();
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = undefined;
      }
      closedIntentionally = true;
      generation += 1;
      try {
        socket?.close(1000, "client dispose");
      } catch {}
      socket = undefined;
      if (state !== "disconnected")
        emitConnection("disconnected");
    }
  };
}

// src/tui/terminal-screen.ts
var import_headless = __toESM(require_xterm_headless(), 1);
var BASE_COLORS = [
  "#000000",
  "#cd0000",
  "#00cd00",
  "#cdcd00",
  "#0000cd",
  "#cd00cd",
  "#00cdcd",
  "#e5e5e5",
  "#7f7f7f",
  "#ff0000",
  "#00ff00",
  "#ffff00",
  "#5c5cff",
  "#ff00ff",
  "#00ffff",
  "#ffffff"
];
function toHex(n) {
  return `#${n.toString(16).padStart(6, "0")}`;
}
function paletteToHex(index) {
  if (index < 0 || index > 255)
    return;
  if (index < 16)
    return BASE_COLORS[index];
  if (index < 232) {
    const i = index - 16;
    const r = Math.floor(i / 36);
    const g = Math.floor(i % 36 / 6);
    const b = i % 6;
    const v = (c) => c === 0 ? 0 : 55 + c * 40;
    return toHex(v(r) << 16 | v(g) << 8 | v(b));
  }
  const g = 8 + (index - 232) * 10;
  return toHex(g << 16 | g << 8 | g);
}
function createTerminalScreen(cols, rows) {
  function makeTerm(nextCols, nextRows) {
    return new import_headless.Terminal({
      cols: nextCols,
      rows: nextRows,
      scrollback: 0,
      allowProposedApi: true
    });
  }
  let term = makeTerm(cols, rows);
  let disposed = false;
  let pendingFlushes = [];
  let cursorVisible = true;
  function trackCursorVisibility(data) {
    if (!data)
      return;
    const re = /\x1b\[\?25([lh])/g;
    let m;
    while ((m = re.exec(data)) !== null) {
      cursorVisible = m[1] === "h";
    }
  }
  function readCursor() {
    try {
      const buf = term.buffer.active;
      const x = typeof buf.cursorX === "number" ? buf.cursorX : 0;
      const y = typeof buf.cursorY === "number" ? buf.cursorY : 0;
      return {
        x: Math.max(0, Math.min(term.cols - 1, x)),
        y: Math.max(0, Math.min(term.rows - 1, y)),
        visible: cursorVisible
      };
    } catch {
      return { x: 0, y: 0, visible: cursorVisible };
    }
  }
  return {
    get cols() {
      return term.cols;
    },
    get rows() {
      return term.rows;
    },
    get activeBuffer() {
      try {
        return term.buffer.active.type === "alternate" ? "alternate" : "normal";
      } catch {
        return "normal";
      }
    },
    get cursor() {
      return readCursor();
    },
    write(data) {
      if (disposed || !data)
        return;
      trackCursorVisibility(data);
      term.write(data);
    },
    flush() {
      if (disposed)
        return Promise.resolve();
      const myTerm = term;
      return new Promise((resolve) => {
        let done = false;
        const finish = () => {
          if (done)
            return;
          done = true;
          pendingFlushes = pendingFlushes.filter((f) => f !== finish);
          resolve();
        };
        pendingFlushes.push(finish);
        try {
          myTerm.write("", finish);
        } catch {
          finish();
        }
      });
    },
    resize(nextCols, nextRows) {
      if (disposed)
        return;
      if (!Number.isInteger(nextCols) || !Number.isInteger(nextRows))
        return;
      if (nextCols <= 0 || nextRows <= 0)
        return;
      if (nextCols === term.cols && nextRows === term.rows)
        return;
      try {
        term.resize(nextCols, nextRows);
      } catch {}
    },
    reset() {
      if (disposed)
        return;
      cursorVisible = true;
      let nextCols = 80;
      let nextRows = 24;
      try {
        nextCols = term.cols;
        nextRows = term.rows;
      } catch {}
      const stale = term;
      try {
        stale.dispose();
      } catch {}
      const waiters = pendingFlushes;
      pendingFlushes = [];
      for (const w of waiters) {
        try {
          w();
        } catch {}
      }
      term = makeTerm(nextCols, nextRows);
    },
    readScreen() {
      const out = [];
      if (disposed)
        return out;
      let active;
      try {
        active = term.buffer.active;
      } catch {
        return out;
      }
      const c = term.cols;
      const r = term.rows;
      for (let y = 0;y < r; y++) {
        let line;
        try {
          line = active.getLine(y);
        } catch {
          line = undefined;
        }
        for (let x = 0;x < c; x++) {
          let cell;
          try {
            cell = line?.getCell(x);
          } catch {
            cell = undefined;
          }
          if (!cell) {
            out.push({ text: " " });
            continue;
          }
          const text = cell.getChars() || " ";
          const entry = { text };
          try {
            const w = cell.getWidth();
            if (w === 0 || w === 2)
              entry.width = w;
          } catch {}
          try {
            if (!cell.isFgDefault()) {
              if (cell.isFgRGB())
                entry.fg = toHex(cell.getFgColor());
              else if (cell.isFgPalette())
                entry.fg = paletteToHex(cell.getFgColor());
            }
            if (!cell.isBgDefault()) {
              if (cell.isBgRGB())
                entry.bg = toHex(cell.getBgColor());
              else if (cell.isBgPalette())
                entry.bg = paletteToHex(cell.getBgColor());
            }
            if (cell.isBold())
              entry.bold = true;
            if (cell.isUnderline())
              entry.underline = true;
            if (cell.isInverse())
              entry.inverse = true;
          } catch {}
          if (entry.inverse) {
            const fg = entry.fg;
            entry.fg = entry.bg;
            entry.bg = fg;
          }
          out.push(entry);
        }
      }
      return out;
    },
    serialize() {
      if (disposed)
        return [];
      const cells = this.readScreen();
      const rows = [];
      const c = term.cols;
      const r = term.rows;
      for (let y = 0;y < r; y++) {
        let row = "";
        for (let x = 0;x < c; x++) {
          row += cells[y * c + x]?.text ?? " ";
        }
        rows.push(row);
      }
      return rows;
    },
    dispose() {
      disposed = true;
      const waiters = pendingFlushes;
      pendingFlushes = [];
      for (const w of waiters) {
        try {
          w();
        } catch {}
      }
      try {
        term.dispose();
      } catch {}
    }
  };
}
function createCommandScreenFeed(screen) {
  let end;
  return {
    get endOffset() {
      return end;
    },
    applySnapshot(data, _startOffset, endOffset) {
      screen.reset();
      if (data)
        screen.write(data);
      end = endOffset;
    },
    applyDelta(data, startOffset, endOffset) {
      if (end === undefined)
        return false;
      if (startOffset !== end)
        return false;
      if (data)
        screen.write(data);
      end = endOffset;
      return true;
    },
    reset() {
      screen.reset();
      end = undefined;
    }
  };
}

// src/tui/command-panel.tsx
function prevent2(evt) {
  const e = evt;
  e.preventDefault?.();
  e.stopPropagation?.();
}
function routeOwnerSessionID(api) {
  return currentRouteSessionID(api);
}
function sameStyle(a, b) {
  return a.fg === b.fg && a.bg === b.bg && a.bold === b.bold && a.underline === b.underline;
}
function buildScreenRows(cells, cols) {
  const rows = [];
  const rowCount = Math.floor(cells.length / cols);
  for (let y = 0;y < rowCount; y++) {
    const runs = [];
    let current;
    for (let x = 0;x < cols; x++) {
      const cell = cells[y * cols + x];
      if (!cell)
        continue;
      const prev = x > 0 ? cells[y * cols + x - 1] : undefined;
      if (current && prev && sameStyle(cell, prev)) {
        current.text += cell.text;
      } else {
        current = {
          text: cell.text
        };
        if (cell.fg !== undefined)
          current.fg = cell.fg;
        if (cell.bg !== undefined)
          current.bg = cell.bg;
        if (cell.bold)
          current.bold = true;
        if (cell.underline)
          current.underline = true;
        runs.push(current);
      }
    }
    while (runs.length > 1 && runs[runs.length - 1] && /^ *$/.test(runs[runs.length - 1].text))
      runs.pop();
    const first = runs[0];
    if (runs.length === 1 && first && /^ *$/.test(first.text))
      first.text = " ";
    rows.push({
      runs
    });
  }
  while (rows.length > 1) {
    const last = rows[rows.length - 1];
    if (!last || !last.runs.every((r) => /^ *$/.test(r.text)))
      break;
    rows.pop();
  }
  return rows;
}
function CommandPanel(props) {
  const theme = () => props.api.theme.current;
  const [state, setState] = createSignal2(emptyCommandPanelState());
  const [output, setOutput] = createSignal2("");
  const [outputMeta, setOutputMeta] = createSignal2({
    startByte: 0,
    totalBytes: 0,
    live: false
  });
  const [insertMode, setInsertMode] = createSignal2(false);
  const [inputValue, setInputValue] = createSignal2("");
  const [statusText, setStatusText] = createSignal2("commands: j/k move \xB7 o fullscreen \xB7 enter write-mode \xB7 ctrl-c interrupt \xB7 :terminate :remove :resize :await \xB7 q detach");
  let inputEl;
  const client = createControlClient(props.directory);
  const ownerSessionID = props.ownerSessionID ?? routeOwnerSessionID(props.api);
  const stream = createCommandStreamClient();
  let subscribedID;
  let streamConnected = false;
  let lastSlowListRefresh = 0;
  const SLOW_LIST_REFRESH_MS = 30000;
  const [screenRows, setScreenRows] = createSignal2([]);
  const [emulated, setEmulated] = createSignal2(false);
  let screen;
  let feed;
  let feedForID;
  const ptyKnown = new Map;
  let screenDirty = false;
  let screenFlushTimer;
  let lastScreenFlushAt = 0;
  const SCREEN_FLUSH_MIN_MS = 120;
  let lastResizeAppliedAt = 0;
  const RESIZE_DEBOUNCE_MS = 500;
  let autoResizeTimer;
  let pendingAutoResize;
  function emuSizeFor(cmd) {
    return {
      cols: cmd.cols ?? 80,
      rows: cmd.rows ?? 24
    };
  }
  function ensureEmulatorFor(cmd) {
    if (!screen || !feed) {
      const size = emuSizeFor(cmd);
      screen = createTerminalScreen(size.cols, size.rows);
      feed = createCommandScreenFeed(screen);
      feedForID = undefined;
    }
    if (feedForID === cmd.id)
      return;
    const size = emuSizeFor(cmd);
    screen.resize(size.cols, size.rows);
    feed.reset();
    feedForID = cmd.id;
    setScreenRows([]);
    screenDirty = false;
    setEmulated(ptyKnown.get(cmd.id) === true);
  }
  function flushScreenRows() {
    lastScreenFlushAt = Date.now();
    if (!screenDirty)
      return;
    screenDirty = false;
    if (!screen || !feedForID)
      return;
    const sel = state().selectedCommand;
    if (!sel || sel.id !== feedForID)
      return;
    if (ptyKnown.get(sel.id) !== true)
      return;
    try {
      setScreenRows(buildScreenRows(screen.readScreen(), screen.cols));
    } catch {}
  }
  function markScreenDirty() {
    screenDirty = true;
    if (screenFlushTimer)
      return;
    const wait = Math.max(0, SCREEN_FLUSH_MIN_MS - (Date.now() - lastScreenFlushAt));
    screenFlushTimer = setTimeout(() => {
      screenFlushTimer = undefined;
      flushScreenRows();
    }, wait);
  }
  function feedSnapshotFor(id, data, startOffset, endOffset) {
    if (!feed || feedForID !== id)
      return;
    feed.applySnapshot(data, startOffset, endOffset);
    markScreenDirty();
  }
  function feedDeltaFor(id, data, startOffset, endOffset) {
    if (!feed || feedForID !== id)
      return;
    if (feed.applyDelta(data, startOffset, endOffset))
      markScreenDirty();
  }
  async function doResizeAndLearn(cols, rows) {
    const id = selectedID();
    if (!id || !ownerSessionID)
      return;
    lastResizeAppliedAt = Date.now();
    try {
      screen?.resize(cols, rows);
      const r = await client.executeRaw({
        command: "cmd_resize",
        goalID: id,
        args: {
          commandID: id,
          cols,
          rows,
          ownerSessionID
        }
      });
      ptyKnown.set(id, r.ok);
      if (selectedID() === id) {
        setEmulated(r.ok);
        if (r.ok)
          markScreenDirty();
        else
          setStatusText(r.message);
      }
      if (r.ok)
        await refresh();
    } catch (e) {
      setStatusText(`Error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  function scheduleAutoResize(cmd) {
    if (!ownerSessionID)
      return;
    if (ptyKnown.has(cmd.id))
      return;
    pendingAutoResize = emuSizeFor(cmd);
    if (autoResizeTimer)
      return;
    const wait = Math.max(0, RESIZE_DEBOUNCE_MS - (Date.now() - lastResizeAppliedAt));
    autoResizeTimer = setTimeout(() => {
      autoResizeTimer = undefined;
      const p = pendingAutoResize;
      pendingAutoResize = undefined;
      if (!p)
        return;
      if (selectedID() !== cmd.id)
        return;
      doResizeAndLearn(p.cols, p.rows);
    }, wait);
  }
  function selectChanged() {
    const sel = state().selectedCommand;
    syncStreamSubscription();
    if (sel) {
      ensureEmulatorFor(sel);
      scheduleAutoResize(sel);
    }
    refreshOutput();
  }
  function streamLiveForSelected() {
    const id = state().selectedCommand?.id;
    return streamConnected && !!id && stream.isLive(id);
  }
  function applyCommandMetadata(cmd) {
    setState((prev) => {
      const idx = prev.commands.findIndex((c) => c.id === cmd.id);
      if (idx < 0)
        return prev;
      const next = [...prev.commands];
      next[idx] = cmd;
      return {
        ...prev,
        commands: next,
        selectedCommand: next[prev.selected] ?? null
      };
    });
  }
  function syncStreamSubscription() {
    const sel = state().selectedCommand;
    if (!ownerSessionID || !sel) {
      if (subscribedID) {
        stream.unsubscribe(subscribedID);
        subscribedID = undefined;
      }
      return;
    }
    if (subscribedID === sel.id && stream.isLive(sel.id))
      return;
    if (subscribedID && subscribedID !== sel.id)
      stream.unsubscribe(subscribedID);
    subscribedID = sel.id;
    stream.subscribe(sel.id, ownerSessionID, {
      onSnapshot: (snap) => {
        if (subscribedID !== sel.id)
          return;
        ensureEmulatorFor(snap.command);
        setOutput(snap.data);
        setOutputMeta({
          startByte: snap.startOffset,
          totalBytes: snap.endOffset,
          live: snap.command.status === "running"
        });
        feedSnapshotFor(snap.command.id, snap.data, snap.startOffset, snap.endOffset);
        applyCommandMetadata(snap.command);
      },
      onDelta: (delta) => {
        if (subscribedID !== sel.id)
          return;
        setOutput((prev) => prev + delta.data);
        setOutputMeta((prev) => ({
          ...prev,
          totalBytes: delta.endOffset
        }));
        feedDeltaFor(delta.commandID, delta.data, delta.startOffset, delta.endOffset);
      },
      onStatus: (cmd) => {
        applyCommandMetadata(cmd);
      },
      onError: (message) => {
        setStatusText(message);
      },
      onConnection: (s) => {
        streamConnected = s === "connected";
        if (streamConnected)
          syncStreamSubscription();
      }
    });
    streamConnected = stream.connectionState === "connected";
  }
  async function tryStreamConnect() {
    if (!ownerSessionID)
      return;
    try {
      const r = await stream.connect(props.directory);
      streamConnected = stream.connectionState === "connected";
      if (r.ok)
        syncStreamSubscription();
    } catch {}
  }
  async function refresh() {
    try {
      if (streamLiveForSelected()) {
        const now = Date.now();
        flushScreenRows();
        if (now - lastSlowListRefresh < SLOW_LIST_REFRESH_MS)
          return;
        lastSlowListRefresh = now;
        const s = await readState(props.directory);
        const mine = (s.commands ?? []).filter((c) => ownerSessionID ? c.ownerSessionID === ownerSessionID : false);
        setState((prev) => refreshCommandList(prev, mine));
        syncStreamSubscription();
        return;
      }
      const s = await readState(props.directory);
      const mine = (s.commands ?? []).filter((c) => ownerSessionID ? c.ownerSessionID === ownerSessionID : false);
      setState((prev) => refreshCommandList(prev, mine));
      syncStreamSubscription();
      if (!streamConnected)
        tryStreamConnect();
      await refreshOutput();
    } catch (e) {
      setStatusText(`Error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  async function refreshOutput() {
    if (streamLiveForSelected())
      return;
    const sel = state().selectedCommand;
    if (!sel) {
      setOutput("");
      return;
    }
    try {
      const total = sel.outputBytes;
      const window2 = 32 * 1024;
      const startByte = Math.max(0, total - window2);
      const log = await readCommandLog(props.directory, sel.id, {
        offsetBytes: startByte,
        limitBytes: window2
      });
      if (state().selectedCommand?.id !== sel.id)
        return;
      ensureEmulatorFor(sel);
      setOutput(log.text);
      setOutputMeta({
        startByte: log.startByte,
        totalBytes: total,
        live: sel.status === "running"
      });
      feedSnapshotFor(sel.id, log.text, log.startByte, total);
      flushScreenRows();
    } catch {
      setOutput("");
    }
  }
  async function sendRaw(command, args, commandID) {
    if (!ownerSessionID) {
      setStatusText("No owning session (open from a session view) \u2014 mutations disabled.");
      return;
    }
    setStatusText(`sending ${command}\u2026`);
    try {
      const r = await client.executeRaw({
        command,
        goalID: commandID,
        args: {
          ...args,
          ownerSessionID
        }
      });
      setStatusText(r.ok ? r.message : `Error: ${r.message}`);
      if (r.ok)
        await refresh();
    } catch (e) {
      setStatusText(`Error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  function selectedID() {
    return state().selectedCommand?.id;
  }
  async function openCmd() {
    await refreshOutput();
    setStatusText("open-cmd: output snapshot refreshed (live while running).");
  }
  async function writeInput(text) {
    const id = selectedID();
    if (!id) {
      setStatusText("No command selected.");
      return;
    }
    const payload = text.endsWith(`
`) ? text : `${text}
`;
    if (streamLiveForSelected() && stream.sendInput(id, payload).ok)
      return;
    await sendRaw("cmd_write", {
      commandID: id,
      input: payload
    }, id);
  }
  async function interrupt() {
    const id = selectedID();
    if (!id) {
      setStatusText("No command selected.");
      return;
    }
    if (streamLiveForSelected() && stream.sendInterrupt(id).ok)
      return;
    await sendRaw("cmd_interrupt", {
      commandID: id
    }, id);
  }
  async function terminate() {
    const id = selectedID();
    if (!id) {
      setStatusText("No command selected.");
      return;
    }
    await sendRaw("cmd_terminate", {
      commandID: id
    }, id);
  }
  async function remove() {
    const id = selectedID();
    if (!id) {
      setStatusText("No command selected.");
      return;
    }
    await sendRaw("cmd_remove", {
      commandID: id
    }, id);
  }
  async function awaitExit(goalID) {
    const sel = state().selectedCommand;
    if (!sel) {
      setStatusText("No command selected.");
      return;
    }
    const target = (goalID || sel.goalID || "").trim();
    if (!target) {
      setStatusText("Usage: :await <goalID> (selected command has no linked goal to default to).");
      return;
    }
    await sendRaw("cmd_await", {
      commandID: sel.id,
      goalID: target
    }, sel.id);
  }
  async function resize(cols, rows) {
    const id = selectedID();
    if (!id) {
      setStatusText("No command selected.");
      return;
    }
    if (Date.now() - lastResizeAppliedAt < RESIZE_DEBOUNCE_MS) {
      setStatusText("resize debounced \u2014 retry in a moment.");
      return;
    }
    await doResizeAndLearn(cols, rows);
  }
  async function startNew(raw) {
    const parts = parseCommandLine(raw);
    if (!parts) {
      setStatusText("Invalid command line: close quotes and trailing escapes.");
      return;
    }
    if (parts.length === 0) {
      setStatusText("Usage: :new <command> [args...]");
      return;
    }
    const [command, ...cmdArgs] = parts;
    if (!ownerSessionID) {
      setStatusText("No owning session (open from a session view) \u2014 mutations disabled.");
      return;
    }
    setStatusText(`sending cmd_start\u2026`);
    try {
      const r = await client.executeRaw({
        command: "cmd_start",
        args: {
          title: command,
          command,
          cmdArgs,
          ownerSessionID
        }
      });
      setStatusText(r.ok ? r.message : `Error: ${r.message}`);
      if (r.ok)
        await refresh();
    } catch (e) {
      setStatusText(`Error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  async function executeColonCommand(raw) {
    const text = raw.startsWith(":") ? raw.slice(1) : raw;
    const [verb, ...rest] = text.trim().split(/\s+/);
    switch (verb) {
      case "new":
        await startNew(rest.join(" "));
        break;
      case "terminate":
        await terminate();
        break;
      case "remove":
        await remove();
        break;
      case "interrupt":
        await interrupt();
        break;
      case "resize": {
        const cols = Number(rest[0]);
        const rows = Number(rest[1]);
        if (!Number.isInteger(cols) || !Number.isInteger(rows)) {
          setStatusText("Usage: :resize <cols> <rows> (stored only \u2014 unsupported by pipe host)");
          break;
        }
        await resize(cols, rows);
        break;
      }
      case "open-cmd":
        await openCmd();
        break;
      case "await":
        await awaitExit(rest[0]);
        break;
      default:
        setStatusText(`Unknown :${verb}. Try :new, :terminate, :remove, :interrupt, :resize, :open-cmd, :await <goalID>`);
    }
  }
  function focusInput() {
    setTimeout(() => {
      const current = props.api.renderer.currentFocusedRenderable;
      if (current && current !== inputEl)
        current.blur();
      inputEl?.focus();
    }, 10);
  }
  onMount2(() => {
    refresh();
    tryStreamConnect();
    focusInput();
  });
  const pollers = [setInterval(refresh, 2000), setInterval(refreshOutput, 2000)];
  const unsubs = [props.api.event.on("session.idle", () => refresh()), props.api.event.on("session.status", () => refresh())];
  onCleanup2(() => {
    for (const u of unsubs)
      if (typeof u === "function")
        u();
    for (const p of pollers)
      clearInterval(p);
    if (screenFlushTimer)
      clearTimeout(screenFlushTimer);
    if (autoResizeTimer)
      clearTimeout(autoResizeTimer);
    screenFlushTimer = undefined;
    autoResizeTimer = undefined;
    try {
      screen?.dispose();
    } catch {}
    screen = undefined;
    feed = undefined;
    feedForID = undefined;
    if (subscribedID)
      stream.unsubscribe(subscribedID);
    subscribedID = undefined;
    stream.dispose();
  });
  useKeyboard2((evt) => {
    const name = (evt.name || "").toLowerCase();
    const seq = evt.sequence || "";
    const raw = evt.raw || "";
    const key = raw || seq || name;
    const ctrlC = Boolean(evt.ctrl) && name === "c";
    if (insertMode()) {
      if (isEnterKey(evt)) {
        prevent2(evt);
        const v = inputValue();
        if (v.startsWith(":"))
          executeColonCommand(v);
        else
          writeInput(v);
        setInputValue("");
        if (inputEl)
          inputEl.value = "";
        setInsertMode(false);
        return;
      }
      if (isEscapeKey(evt)) {
        prevent2(evt);
        setInsertMode(false);
        setInputValue("");
        if (inputEl)
          inputEl.value = "";
        return;
      }
      return;
    }
    if (ctrlC) {
      prevent2(evt);
      interrupt();
      return;
    }
    if (key === ":") {
      prevent2(evt);
      setInsertMode(true);
      focusInput();
      return;
    }
    if (name === "down" || key === "j") {
      prevent2(evt);
      setState((s) => moveCommandSelection(s, 1));
      selectChanged();
      return;
    }
    if (name === "up" || key === "k") {
      prevent2(evt);
      setState((s) => moveCommandSelection(s, -1));
      selectChanged();
      return;
    }
    if (key === "g") {
      prevent2(evt);
      setState(selectCommandFirst);
      selectChanged();
      return;
    }
    if (key === "G") {
      prevent2(evt);
      setState(selectCommandLast);
      selectChanged();
      return;
    }
    if (key === "o") {
      prevent2(evt);
      const selCmd = state().selectedCommand;
      const returnSessionID = routeOwnerSessionID(props.api);
      const target = resolveOpenTarget({
        selection: selCmd ? {
          kind: "command",
          commandID: selCmd.id
        } : null,
        ownerSessionID,
        returnSessionID
      });
      if (target.kind === "none") {
        setStatusText(target.reason === "no-command" ? "No command selected." : target.reason === "owner-required" ? "No owning session (open from a session view) \u2014 open disabled." : "No return session \u2014 open disabled.");
        return;
      }
      if (target.kind !== "command")
        return;
      if (props.onOpenCommand) {
        props.onOpenCommand(target.data);
        return;
      }
      try {
        props.api.route.navigate(TERMINAL_ROUTE_NAME, terminalRoutePayload(target.data.commandID, target.data.ownerSessionID, target.data.returnSessionID));
        if (props.onDetach)
          props.onDetach();
        else
          props.api.ui.dialog.clear();
      } catch {
        setStatusText("Fullscreen route unavailable on this host \u2014 staying in the monitor.");
      }
      return;
    }
    if (key === "q") {
      prevent2(evt);
      if (props.onDetach)
        props.onDetach();
      else
        props.api.ui.dialog.clear();
      return;
    }
  });
  const sel = () => state().selectedCommand;
  return (() => {
    var _el$ = _$createElement2("box"), _el$2 = _$createElement2("box"), _el$3 = _$createElement2("box"), _el$4 = _$createElement2("text"), _el$5 = _$createElement2("span"), _el$7 = _$createElement2("span"), _el$8 = _$createElement2("text"), _el$9 = _$createElement2("span"), _el$0 = _$createTextNode2(` owned`), _el$10 = _$createElement2("box"), _el$11 = _$createElement2("text"), _el$12 = _$createElement2("span"), _el$13 = _$createElement2("input");
    _$insertNode2(_el$, _el$2);
    _$setProp2(_el$, "flexDirection", "column");
    _$setProp2(_el$, "width", "100%");
    _$setProp2(_el$, "alignItems", "center");
    _$setProp2(_el$, "padding", 1);
    _$insertNode2(_el$2, _el$3);
    _$insertNode2(_el$2, _el$10);
    _$setProp2(_el$2, "flexDirection", "column");
    _$setProp2(_el$2, "width", "90%");
    _$setProp2(_el$2, "border", true);
    _$setProp2(_el$2, "padding", 1);
    _$insertNode2(_el$3, _el$4);
    _$insertNode2(_el$3, _el$8);
    _$setProp2(_el$3, "flexDirection", "row");
    _$setProp2(_el$3, "justifyContent", "space-between");
    _$setProp2(_el$3, "flexShrink", 0);
    _$insertNode2(_el$4, _el$5);
    _$insertNode2(_el$4, _el$7);
    _$insertNode2(_el$5, _$createTextNode2(`\u2B22 Command Sessions`));
    _$insert2(_el$7, () => emulated() ? " \u2502 terminal screen (emulated view \xB7 raw log is the record)" : " \u2502 byte-stream output (raw text)");
    _$insertNode2(_el$8, _el$9);
    _$insertNode2(_el$9, _el$0);
    _$insert2(_el$9, () => state().commands.length, _el$0);
    _$insert2(_el$2, _$createComponent2(Show2, {
      get when() {
        return state().commands.length > 0;
      },
      get fallback() {
        return (() => {
          var _el$14 = _$createElement2("box"), _el$15 = _$createElement2("text"), _el$16 = _$createElement2("span");
          _$insertNode2(_el$14, _el$15);
          _$setProp2(_el$14, "padding", 1);
          _$insertNode2(_el$15, _el$16);
          _$insert2(_el$16, ownerSessionID ? "No command sessions. :new <command> [args...] to start one." : "Open this panel from a session view \u2014 owner scoping needs a session.");
          _$effect2((_$p) => _$setProp2(_el$16, "style", {
            fg: theme().textMuted
          }, _$p));
          return _el$14;
        })();
      },
      get children() {
        var _el$1 = _$createElement2("box");
        _$setProp2(_el$1, "flexDirection", "column");
        _$setProp2(_el$1, "flexShrink", 1);
        _$setProp2(_el$1, "minHeight", 0);
        _$setProp2(_el$1, "overflow", "hidden");
        _$insert2(_el$1, _$createComponent2(For2, {
          get each() {
            return state().commands;
          },
          children: (cmd, i) => (() => {
            var _el$17 = _$createElement2("box"), _el$18 = _$createElement2("text"), _el$19 = _$createElement2("span"), _el$20 = _$createElement2("span"), _el$21 = _$createTextNode2(` \u2502 `), _el$22 = _$createTextNode2(` \u2502 `);
            _$insertNode2(_el$17, _el$18);
            _$setProp2(_el$17, "paddingLeft", 1);
            _$setProp2(_el$17, "paddingRight", 1);
            _$insertNode2(_el$18, _el$19);
            _$insertNode2(_el$18, _el$20);
            _$setProp2(_el$18, "wrapMode", "none");
            _$setProp2(_el$18, "truncate", true);
            _$insert2(_el$19, () => i() === state().selected ? "\u25B6 " : "  ", null);
            _$insert2(_el$19, () => cmd.title, null);
            _$insertNode2(_el$20, _el$21);
            _$insertNode2(_el$20, _el$22);
            _$insert2(_el$20, () => [cmd.command, ...cmd.args].join(" ").slice(0, 60), _el$22);
            _$insert2(_el$20, () => cmd.status, null);
            _$insert2(_el$20, (() => {
              var _c$ = _$memo2(() => cmd.exitCode !== undefined);
              return () => _c$() ? ` (${cmd.exitCode})` : "";
            })(), null);
            _$effect2((_p$) => {
              var _v$10 = i() === state().selected ? theme().backgroundElement : undefined, _v$11 = {
                fg: cmd.status === "running" ? theme().success : theme().textMuted,
                bold: i() === state().selected
              }, _v$12 = {
                fg: theme().textMuted
              };
              _v$10 !== _p$.e && (_p$.e = _$setProp2(_el$17, "backgroundColor", _v$10, _p$.e));
              _v$11 !== _p$.t && (_p$.t = _$setProp2(_el$19, "style", _v$11, _p$.t));
              _v$12 !== _p$.a && (_p$.a = _$setProp2(_el$20, "style", _v$12, _p$.a));
              return _p$;
            }, {
              e: undefined,
              t: undefined,
              a: undefined
            });
            return _el$17;
          })()
        }));
        return _el$1;
      }
    }), _el$10);
    _$insert2(_el$2, _$createComponent2(Show2, {
      get when() {
        return sel();
      },
      children: (cmd) => (() => {
        var _el$23 = _$createElement2("box"), _el$24 = _$createElement2("text"), _el$25 = _$createElement2("span"), _el$26 = _$createElement2("span"), _el$27 = _$createTextNode2(` \u2502 `), _el$28 = _$createTextNode2(` \u2502 `), _el$29 = _$createTextNode2(` \u2502 `), _el$30 = _$createTextNode2(` bytes`);
        _$insertNode2(_el$23, _el$24);
        _$setProp2(_el$23, "flexDirection", "column");
        _$setProp2(_el$23, "border", true);
        _$setProp2(_el$23, "padding", 1);
        _$setProp2(_el$23, "flexShrink", 0);
        _$setProp2(_el$23, "maxHeight", 16);
        _$setProp2(_el$23, "overflow", "hidden");
        _$insertNode2(_el$24, _el$25);
        _$insertNode2(_el$24, _el$26);
        _$insert2(_el$25, () => cmd().title);
        _$insertNode2(_el$26, _el$27);
        _$insertNode2(_el$26, _el$28);
        _$insertNode2(_el$26, _el$29);
        _$insertNode2(_el$26, _el$30);
        _$insert2(_el$26, () => [cmd().command, ...cmd().args].join(" "), _el$28);
        _$insert2(_el$26, () => cmd().status, _el$29);
        _$insert2(_el$26, () => outputMeta().totalBytes, _el$30);
        _$insert2(_el$26, () => outputMeta().live ? " \xB7 live" : "", null);
        _$insert2(_el$26, () => cmd().truncated ? " \xB7 truncated" : "", null);
        _$insert2(_el$26, (() => {
          var _c$2 = _$memo2(() => !!(emulated() && screen && feedForID === cmd().id));
          return () => _c$2() ? ` \xB7 ${screen.cols}x${screen.rows} screen${screen.activeBuffer === "alternate" ? " \xB7 alt-screen" : ""}` : "";
        })(), null);
        _$insert2(_el$23, _$createComponent2(Show2, {
          get when() {
            return _$memo2(() => !!emulated())() && screenRows().length > 0;
          },
          get fallback() {
            return (() => {
              var _el$31 = _$createElement2("text"), _el$32 = _$createElement2("span");
              _$insertNode2(_el$31, _el$32);
              _$insert2(_el$32, () => output().slice(-4000) || "(no output yet)");
              _$effect2((_$p) => _$setProp2(_el$32, "style", {
                fg: theme().text
              }, _$p));
              return _el$31;
            })();
          },
          get children() {
            return _$createComponent2(For2, {
              get each() {
                return screenRows();
              },
              children: (row) => (() => {
                var _el$33 = _$createElement2("text");
                _$setProp2(_el$33, "wrapMode", "none");
                _$setProp2(_el$33, "truncate", true);
                _$insert2(_el$33, _$createComponent2(For2, {
                  get each() {
                    return row.runs;
                  },
                  children: (run) => (() => {
                    var _el$34 = _$createElement2("span");
                    _$insert2(_el$34, () => run.text);
                    _$effect2((_$p) => _$setProp2(_el$34, "style", {
                      fg: run.fg ?? theme().text,
                      bg: run.bg,
                      bold: run.bold,
                      underline: run.underline
                    }, _$p));
                    return _el$34;
                  })()
                }));
                return _el$33;
              })()
            });
          }
        }), null);
        _$effect2((_p$) => {
          var _v$13 = theme().border, _v$14 = {
            fg: theme().primary,
            bold: true
          }, _v$15 = {
            fg: theme().textMuted
          };
          _v$13 !== _p$.e && (_p$.e = _$setProp2(_el$23, "borderColor", _v$13, _p$.e));
          _v$14 !== _p$.t && (_p$.t = _$setProp2(_el$25, "style", _v$14, _p$.t));
          _v$15 !== _p$.a && (_p$.a = _$setProp2(_el$26, "style", _v$15, _p$.a));
          return _p$;
        }, {
          e: undefined,
          t: undefined,
          a: undefined
        });
        return _el$23;
      })()
    }), _el$10);
    _$insertNode2(_el$10, _el$11);
    _$insertNode2(_el$10, _el$13);
    _$setProp2(_el$10, "flexDirection", "row");
    _$setProp2(_el$10, "border", true);
    _$setProp2(_el$10, "paddingLeft", 1);
    _$setProp2(_el$10, "paddingRight", 1);
    _$setProp2(_el$10, "flexShrink", 0);
    _$setProp2(_el$10, "height", 3);
    _$setProp2(_el$10, "gap", 1);
    _$insertNode2(_el$11, _el$12);
    _$insert2(_el$12, () => insertMode() ? " INPUT " : " NORMAL ");
    _$use2((el) => {
      inputEl = el;
    }, _el$13);
    _$setProp2(_el$13, "flexGrow", 1);
    _$setProp2(_el$13, "onInput", (v) => {
      if (insertMode())
        setInputValue(v);
      else if (inputEl?.value)
        inputEl.value = "";
    });
    _$effect2((_p$) => {
      var _v$ = theme().border, _v$2 = {
        fg: theme().primary,
        bold: true
      }, _v$3 = {
        fg: theme().textMuted
      }, _v$4 = {
        fg: theme().textMuted
      }, _v$5 = insertMode() ? theme().warning : theme().border, _v$6 = {
        fg: insertMode() ? theme().warning : theme().success,
        bold: true
      }, _v$7 = insertMode() ? "type stdin, Enter sends (:new/:terminate/:remove/:interrupt/:resize/:open-cmd/:await)" : statusText() || "Press : to type, q to detach", _v$8 = theme().textMuted, _v$9 = theme().primary, _v$0 = theme().text, _v$1 = theme().background;
      _v$ !== _p$.e && (_p$.e = _$setProp2(_el$2, "borderColor", _v$, _p$.e));
      _v$2 !== _p$.t && (_p$.t = _$setProp2(_el$5, "style", _v$2, _p$.t));
      _v$3 !== _p$.a && (_p$.a = _$setProp2(_el$7, "style", _v$3, _p$.a));
      _v$4 !== _p$.o && (_p$.o = _$setProp2(_el$9, "style", _v$4, _p$.o));
      _v$5 !== _p$.i && (_p$.i = _$setProp2(_el$10, "borderColor", _v$5, _p$.i));
      _v$6 !== _p$.n && (_p$.n = _$setProp2(_el$12, "style", _v$6, _p$.n));
      _v$7 !== _p$.s && (_p$.s = _$setProp2(_el$13, "placeholder", _v$7, _p$.s));
      _v$8 !== _p$.h && (_p$.h = _$setProp2(_el$13, "placeholderColor", _v$8, _p$.h));
      _v$9 !== _p$.r && (_p$.r = _$setProp2(_el$13, "cursorColor", _v$9, _p$.r));
      _v$0 !== _p$.d && (_p$.d = _$setProp2(_el$13, "focusedTextColor", _v$0, _p$.d));
      _v$1 !== _p$.l && (_p$.l = _$setProp2(_el$13, "focusedBackgroundColor", _v$1, _p$.l));
      return _p$;
    }, {
      e: undefined,
      t: undefined,
      a: undefined,
      o: undefined,
      i: undefined,
      n: undefined,
      s: undefined,
      h: undefined,
      r: undefined,
      d: undefined,
      l: undefined
    });
    return _el$;
  })();
}

// src/tui/terminal-view.tsx
import { use as _$use3 } from "@opentui/solid";
import { createComponent as _$createComponent3 } from "@opentui/solid";
import { effect as _$effect3 } from "@opentui/solid";
import { insert as _$insert3 } from "@opentui/solid";
import { createTextNode as _$createTextNode3 } from "@opentui/solid";
import { insertNode as _$insertNode3 } from "@opentui/solid";
import { memo as _$memo3 } from "@opentui/solid";
import { setProp as _$setProp3 } from "@opentui/solid";
import { createElement as _$createElement3 } from "@opentui/solid";
import { createSignal as createSignal3, For as For3, Show as Show3, onCleanup as onCleanup3, onMount as onMount3 } from "solid-js";
import { useKeyboard as useKeyboard3, usePaste } from "@opentui/solid";

// src/tui/terminal-session.ts
var TERMINAL_FALLBACK_COLS = 80;
var TERMINAL_FALLBACK_ROWS = 24;
var TERMINAL_POLL_INTERVAL_MS = 2000;
var TERMINAL_RESIZE_DEBOUNCE_MS = 75;
var TERMINAL_LOG_WINDOW_BYTES = 32 * 1024;
function computeViewportSize(measuredWidth, measuredHeight, chromeRows) {
  const cols = Math.floor(measuredWidth);
  const rows = Math.floor(measuredHeight) - chromeRows;
  if (!Number.isFinite(cols) || !Number.isFinite(rows))
    return;
  if (cols < 1 || rows < 1)
    return;
  return { cols, rows };
}
function createTerminalSession(options) {
  const validated = validateTerminalRouteData(options.routeData);
  const data = validated.ok ? validated.data : undefined;
  const invalidReason = validated.ok ? undefined : validated.reason;
  const routeConsistent = !data || isTerminalRouteConsistent(data);
  const routeReason = !data ? invalidReason : routeConsistent ? undefined : "owner-return-mismatch";
  const pollIntervalMs = options.pollIntervalMs ?? TERMINAL_POLL_INTERVAL_MS;
  const resizeDebounceMs = options.resizeDebounceMs ?? TERMINAL_RESIZE_DEBOUNCE_MS;
  const stream = (options.createStreamClient ?? createCommandStreamClient)();
  const control = (options.createControl ?? createControlClient)(options.directory);
  const readStateFn = options.readStateFn ?? readState;
  const readLogFn = options.readLogFn ?? ((dir, id, range) => readCommandLog(dir, id, range));
  let screen;
  let feed;
  let command = null;
  let connection = "polling";
  let connectionDetail = "connecting\u2026";
  let totalBytes = 0;
  let live = false;
  let disposed = false;
  let started = false;
  let appliedSize = { cols: TERMINAL_FALLBACK_COLS, rows: TERMINAL_FALLBACK_ROWS };
  let pollTimer;
  let resizeTimer;
  let pendingResize;
  let emitTimer;
  let lastEmitAt = 0;
  const EMIT_MIN_MS = 120;
  let paintRevision = 0;
  function ensureEmulator() {
    if (screen && feed)
      return;
    const make = options.createScreen ?? createTerminalScreen;
    screen = make(appliedSize.cols, appliedSize.rows);
    feed = createCommandScreenFeed(screen);
  }
  function emit() {
    if (disposed)
      return;
    try {
      options.onSnapshot?.(readView());
    } catch {}
  }
  function emitSoon() {
    if (disposed)
      return;
    const wait = Math.max(0, EMIT_MIN_MS - (Date.now() - lastEmitAt));
    if (emitTimer)
      return;
    emitTimer = setTimeout(() => {
      emitTimer = undefined;
      lastEmitAt = Date.now();
      emit();
    }, wait);
  }
  function applySnapshotBytes(snapshotData, startOffset, endOffset) {
    ensureEmulator();
    const revision = ++paintRevision;
    feed.applySnapshot(snapshotData, startOffset, endOffset);
    totalBytes = endOffset;
    flushThenEmit(revision);
  }
  function applyDeltaBytes(deltaData, startOffset, endOffset) {
    if (!feed)
      return;
    if (feed.applyDelta(deltaData, startOffset, endOffset)) {
      const revision = ++paintRevision;
      totalBytes = endOffset;
      flushThenEmit(revision);
    }
  }
  async function flushThenEmit(revision) {
    try {
      await screen?.flush();
    } catch {}
    if (disposed || revision !== paintRevision)
      return;
    emitSoon();
  }
  function streamLive() {
    return !!data && stream.isLive(data.commandID);
  }
  async function pollOnce() {
    if (disposed || !data)
      return;
    if (!routeConsistent)
      return;
    if (streamLive())
      return;
    try {
      const state = await readStateFn(options.directory);
      const found = (state.commands ?? []).find((c) => c.id === data.commandID) ?? null;
      if (!found) {
        connection = "error";
        connectionDetail = "command not found";
        emitSoon();
        return;
      }
      if (found.ownerSessionID !== data.ownerSessionID) {
        connection = "error";
        connectionDetail = "not owned by this session";
        emitSoon();
        return;
      }
      command = found;
      const windowBytes = TERMINAL_LOG_WINDOW_BYTES;
      const fileStartByte = Math.max(0, found.outputBytes - windowBytes);
      const log = await readLogFn(options.directory, found.id, {
        offsetBytes: fileStartByte,
        limitBytes: windowBytes
      });
      if (disposed || !data)
        return;
      ensureEmulator();
      const lifetimeBase = Math.max(0, (found.streamBytes ?? found.outputBytes) - found.outputBytes);
      const absoluteStart = lifetimeBase + log.startByte;
      const absoluteEnd = absoluteStart + utf8ByteLength(log.text);
      applySnapshotBytes(log.text, absoluteStart, absoluteEnd);
      live = found.status === "running";
      if (connection !== "stream") {
        connection = "polling";
        connectionDetail = "polling fallback (stream unavailable)";
      }
      emitSoon();
    } catch (error) {
      connectionDetail = error instanceof Error ? error.message : String(error);
      emitSoon();
    }
  }
  async function start() {
    if (started || disposed)
      return;
    started = true;
    ensureEmulator();
    if (!data) {
      connection = "error";
      connectionDetail = `invalid route data: ${invalidReason}`;
      emit();
      return;
    }
    if (!routeConsistent) {
      connection = "error";
      connectionDetail = `invalid route data: ${routeReason}`;
      emit();
      pollTimer = setInterval(() => void pollOnce(), pollIntervalMs);
      return;
    }
    try {
      const state = await readStateFn(options.directory);
      const found = (state.commands ?? []).find((c) => c.id === data.commandID);
      if (!found) {
        connection = "error";
        connectionDetail = "command not found";
        emit();
      } else if (found.ownerSessionID !== data.ownerSessionID) {
        connection = "error";
        connectionDetail = "not owned by this session";
        emit();
      } else {
        command = found;
      }
    } catch (error) {
      connectionDetail = error instanceof Error ? error.message : String(error);
    }
    if (connection === "error") {
      pollTimer = setInterval(() => void pollOnce(), pollIntervalMs);
      return;
    }
    try {
      const result = await stream.connect(options.directory);
      if (!result.ok) {
        connection = "polling";
        connectionDetail = "polling fallback (stream unavailable)";
      }
    } catch {
      connection = "polling";
      connectionDetail = "polling fallback (stream unavailable)";
    }
    stream.subscribe(data.commandID, data.ownerSessionID, {
      onSnapshot: (snap) => {
        if (disposed || snap.command.id !== data.commandID)
          return;
        if (snap.command.ownerSessionID !== data.ownerSessionID) {
          connection = "error";
          connectionDetail = "not owned by this session";
          stream.unsubscribe(data.commandID);
          emit();
          return;
        }
        command = snap.command;
        connection = "stream";
        connectionDetail = "live";
        live = snap.command.status === "running";
        applySnapshotBytes(snap.data, snap.startOffset, snap.endOffset);
      },
      onDelta: (delta) => {
        if (disposed || delta.commandID !== data.commandID)
          return;
        applyDeltaBytes(delta.data, delta.startOffset, delta.endOffset);
      },
      onStatus: (cmd) => {
        if (disposed || cmd.id !== data.commandID)
          return;
        if (cmd.ownerSessionID !== data.ownerSessionID)
          return;
        command = cmd;
        live = cmd.status === "running";
        emitSoon();
      },
      onError: (message) => {
        if (disposed)
          return;
        if (/snapshot-timeout|resync-loop-guard/.test(message) && connection !== "error") {
          connection = "polling";
          connectionDetail = "polling fallback (stream unavailable)";
        } else if (connection !== "stream") {
          connectionDetail = message;
        }
        emitSoon();
      },
      onConnection: (next) => {
        if (disposed)
          return;
        if (next === "connected" && connection !== "stream" && connection !== "error") {
          connectionDetail = "stream connected \u2014 awaiting snapshot\u2026";
        } else if (next === "disconnected" && connection === "stream") {
          connection = "polling";
          connectionDetail = "polling fallback (stream unavailable)";
        }
        emitSoon();
      }
    });
    await pollOnce();
    pollTimer = setInterval(() => void pollOnce(), pollIntervalMs);
  }
  function writeInput(bytes) {
    if (disposed || !data || !bytes)
      return;
    if (connection === "error")
      return;
    if (streamLive() && stream.sendInput(data.commandID, bytes).ok)
      return;
    control.executeRaw({ command: "cmd_write", goalID: data.commandID, args: { commandID: data.commandID, input: bytes, ownerSessionID: data.ownerSessionID } }).catch(() => {});
  }
  function paste(text) {
    if (disposed || !data || !text)
      return;
    writeInput(text);
  }
  function interrupt() {
    if (disposed || !data)
      return;
    if (connection === "error")
      return;
    if (streamLive() && stream.sendInterrupt(data.commandID).ok)
      return;
    control.executeRaw({ command: "cmd_interrupt", goalID: data.commandID, args: { commandID: data.commandID, ownerSessionID: data.ownerSessionID } }).catch(() => {});
  }
  function applyResize(cols, rows) {
    if (disposed || !data)
      return;
    appliedSize = { cols, rows };
    try {
      screen?.resize(cols, rows);
    } catch {}
    if (connection === "error") {
      emitSoon();
      return;
    }
    control.executeRaw({ command: "cmd_resize", goalID: data.commandID, args: { commandID: data.commandID, cols, rows, ownerSessionID: data.ownerSessionID } }).catch(() => {});
    emitSoon();
  }
  function requestViewportSize(cols, rows) {
    if (disposed)
      return;
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1)
      return;
    if (cols === appliedSize.cols && rows === appliedSize.rows && !pendingResize)
      return;
    pendingResize = { cols, rows };
    if (resizeTimer)
      return;
    resizeTimer = setTimeout(() => {
      resizeTimer = undefined;
      const next = pendingResize;
      pendingResize = undefined;
      if (!next || disposed)
        return;
      applyResize(next.cols, next.rows);
    }, resizeDebounceMs);
  }
  function cleanup() {
    if (pollTimer)
      clearInterval(pollTimer);
    if (resizeTimer)
      clearTimeout(resizeTimer);
    if (emitTimer)
      clearTimeout(emitTimer);
    pollTimer = undefined;
    resizeTimer = undefined;
    emitTimer = undefined;
    pendingResize = undefined;
    try {
      if (data)
        stream.unsubscribe(data.commandID);
    } catch {}
    try {
      stream.dispose();
    } catch {}
    try {
      screen?.dispose();
    } catch {}
    screen = undefined;
    feed = undefined;
  }
  function detach() {
    if (disposed)
      return;
    cleanup();
    disposed = true;
    try {
      options.onDetach?.();
    } catch {}
  }
  function dispose() {
    if (disposed)
      return;
    cleanup();
    disposed = true;
  }
  function readView() {
    ensureEmulator();
    let rows = [];
    try {
      rows = screen.readScreen();
    } catch {
      rows = [];
    }
    let cursor = { x: 0, y: 0, visible: true };
    try {
      cursor = screen.cursor;
    } catch {}
    let activeBuffer = "normal";
    try {
      activeBuffer = screen.activeBuffer;
    } catch {}
    return {
      rows,
      cols: screen.cols,
      viewportRows: screen.rows,
      cursor,
      activeBuffer,
      command,
      connection,
      connectionDetail,
      totalBytes,
      live,
      invalid: routeReason
    };
  }
  return {
    get data() {
      return data;
    },
    get invalidReason() {
      return routeReason;
    },
    start,
    writeInput,
    paste,
    interrupt,
    detach,
    requestViewportSize,
    get appliedSize() {
      return { ...appliedSize };
    },
    readView,
    dispose
  };
}

// src/tui/terminal-keys.ts
function isDetachChord(evt) {
  if (!evt || evt.release)
    return false;
  if (!evt.ctrl)
    return false;
  const name = (evt.name ?? "").toLowerCase();
  return name === "]" || evt.sequence === "\x1D";
}
function isInterruptChord(evt) {
  if (!evt || evt.release)
    return false;
  if (!evt.ctrl)
    return false;
  return (evt.name ?? "").toLowerCase() === "c";
}
var CSI = "\x1B[";
function isKittyEncoding(name, sequence) {
  if (/^\x1b\[[0-9;?]*u$/i.test(sequence))
    return true;
  if (/^kitty/i.test(name))
    return true;
  return false;
}
var CONVENTIONAL_NAMES = new Set([
  "return",
  "enter",
  "kp_enter",
  "tab",
  "backspace",
  "escape",
  "esc",
  "up",
  "down",
  "right",
  "left",
  "home",
  "end",
  "delete",
  "del",
  "pageup",
  "page_up",
  "pagedown",
  "page_down",
  "space"
]);
function isConventionalVT(name, sequence, text) {
  if (CONVENTIONAL_NAMES.has(name))
    return true;
  if (text.length === 1)
    return true;
  if (sequence.length === 1 && sequence >= " " && sequence !== "\x7F")
    return true;
  return false;
}
function encodeTerminalKey(evt) {
  if (!evt || evt.release)
    return;
  const rawName = (evt.name ?? "").toLowerCase();
  const seq = evt.sequence ?? "";
  const text = evt.text ?? "";
  const ctrl = Boolean(evt.ctrl);
  const alt = Boolean(evt.alt || evt.meta || evt.option);
  if (isDetachChord(evt))
    return;
  if (evt.source === "kitty" && !isConventionalVT(rawName, seq, text))
    return;
  if (isKittyEncoding(rawName, seq))
    return;
  switch (rawName) {
    case "return":
    case "enter":
    case "kp_enter":
      return alt ? `\x1B\r` : "\r";
    case "tab":
      return alt ? "\x1B\t" : "\t";
    case "backspace":
      return alt ? "\x1B\x7F" : "\x7F";
    case "escape":
    case "esc":
      return "\x1B";
    case "up":
      return alt ? `\x1B${CSI}A` : `${CSI}A`;
    case "down":
      return alt ? `\x1B${CSI}B` : `${CSI}B`;
    case "right":
      return alt ? `\x1B${CSI}C` : `${CSI}C`;
    case "left":
      return alt ? `\x1B${CSI}D` : `${CSI}D`;
    case "home":
      return alt ? `\x1B${CSI}H` : `${CSI}H`;
    case "end":
      return alt ? `\x1B${CSI}F` : `${CSI}F`;
    case "delete":
    case "del":
      return alt ? `\x1B${CSI}3~` : `${CSI}3~`;
    case "pageup":
    case "page_up":
      return alt ? `\x1B${CSI}5~` : `${CSI}5~`;
    case "pagedown":
    case "page_down":
      return alt ? `\x1B${CSI}6~` : `${CSI}6~`;
    case "space":
      if (ctrl)
        return "\x00";
      return alt ? "\x1B " : " ";
    default:
      break;
  }
  if (ctrl) {
    const letter = rawName.length === 1 ? rawName : text.length === 1 ? text.toLowerCase() : "";
    if (/^[a-z]$/.test(letter)) {
      const byte = letter.charCodeAt(0) - 96;
      const out = String.fromCharCode(byte);
      return alt ? `\x1B${out}` : out;
    }
    if (rawName === "[" || seq === "\x1B")
      return "\x1B";
    if (rawName === "\\")
      return alt ? "\x1B\x1C" : "\x1C";
    if (rawName === "^" || rawName === "6")
      return alt ? "\x1B\x1E" : "\x1E";
    if (rawName === "_" || rawName === "-")
      return alt ? "\x1B\x1F" : "\x1F";
    return;
  }
  if (text.length === 1) {
    return alt ? `\x1B${text}` : text;
  }
  if (seq.length === 1 && seq >= " " && seq !== "\x7F") {
    return alt ? `\x1B${seq}` : seq;
  }
  const knownVT = new Set([
    "\r",
    `
`,
    "\t",
    "\x7F",
    "\x1B",
    `${CSI}A`,
    `${CSI}B`,
    `${CSI}C`,
    `${CSI}D`,
    `${CSI}H`,
    `${CSI}F`,
    `${CSI}3~`,
    `${CSI}5~`,
    `${CSI}6~`,
    "\x1BOA",
    "\x1BOB",
    "\x1BOC",
    "\x1BOD",
    "\x1BOH",
    "\x1BOF"
  ]);
  if (knownVT.has(seq)) {
    return alt && !seq.startsWith("\x1B") ? `\x1B${seq}` : seq;
  }
  return;
}

// src/tui/terminal-view.tsx
var TERMINAL_INPUT_MODE = "loopd.terminal";
function prevent3(evt) {
  const e = evt;
  e.preventDefault?.();
  e.stopPropagation?.();
}
function toKeyEvent(evt) {
  const e = evt;
  return {
    name: e.name,
    text: e.text,
    sequence: e.sequence ?? e.raw,
    ctrl: e.ctrl,
    alt: evt.alt,
    meta: e.meta,
    option: e.option,
    shift: e.shift,
    source: e.source,
    release: e.eventType === "release",
    repeated: evt.repeated
  };
}
function sameStyle2(a, b) {
  return a.fg === b.fg && a.bg === b.bg && a.bold === b.bold && a.underline === b.underline && (a.inverse ?? false) === (b.inverse ?? false);
}
function isDroppableBlank(run) {
  if (!/^ *$/.test(run.text))
    return false;
  return run.fg === undefined && run.bg === undefined && !run.bold && !run.underline && !run.inverse && !run.cursor;
}
function buildTerminalRows(cells, cols, rows, cursor) {
  const out = [];
  for (let y = 0;y < rows; y++) {
    const runs = [];
    let current;
    let prev;
    let prevIsCursor = false;
    for (let x = 0;x < cols; x++) {
      const cell = cells[y * cols + x];
      if (!cell)
        continue;
      if (cell.width === 0)
        continue;
      const isCursor = cursor.visible && cursor.y === y && cursor.x === x;
      if (current && prev && sameStyle2(cell, prev) && isCursor === prevIsCursor) {
        current.text += cell.text;
      } else {
        current = {
          text: cell.text
        };
        if (cell.fg !== undefined)
          current.fg = cell.fg;
        if (cell.bg !== undefined)
          current.bg = cell.bg;
        if (cell.bold)
          current.bold = true;
        if (cell.underline)
          current.underline = true;
        if (cell.inverse)
          current.inverse = true;
        if (isCursor)
          current.cursor = true;
        runs.push(current);
      }
      prev = cell;
      prevIsCursor = isCursor;
    }
    while (runs.length > 1 && runs[runs.length - 1] && isDroppableBlank(runs[runs.length - 1]))
      runs.pop();
    const first = runs[0];
    if (runs.length === 0)
      runs.push({
        text: " "
      });
    else if (runs.length === 1 && first && isDroppableBlank(first))
      first.text = " ";
    out.push(runs);
  }
  return out;
}
function TerminalView(props) {
  const theme = () => props.api.theme.current;
  const makeSession = props.createSession ?? createTerminalSession;
  const [view, setView] = createSignal3(null);
  let viewportEl;
  let measureTimer;
  let popTerminalMode;
  const session = makeSession({
    directory: props.directory,
    routeData: props.data,
    onSnapshot: (snap) => setView({
      ...snap
    }),
    onDetach: () => {
      if (props.onDetach) {
        props.onDetach();
        return;
      }
      const ret = session.data?.returnSessionID;
      if (ret) {
        try {
          props.api.route.navigate("session", {
            sessionID: ret
          });
        } catch {}
      }
    }
  });
  function measureViewport() {
    try {
      const w = viewportEl?.width;
      const h = viewportEl?.height;
      if (typeof w !== "number" || typeof h !== "number")
        return;
      const size = computeViewportSize(w, h, 0);
      if (size)
        session.requestViewportSize(size.cols, size.rows);
    } catch {}
  }
  onMount3(() => {
    try {
      const push = props.api.mode?.push;
      if (typeof push === "function") {
        popTerminalMode = push.call(props.api.mode, TERMINAL_INPUT_MODE);
      }
    } catch {}
    session.start();
    setTimeout(measureViewport, 50);
    measureTimer = setInterval(measureViewport, 1000);
  });
  onCleanup3(() => {
    if (measureTimer)
      clearInterval(measureTimer);
    measureTimer = undefined;
    viewportEl = undefined;
    try {
      popTerminalMode?.();
    } catch {}
    popTerminalMode = undefined;
    session.dispose();
  });
  useKeyboard3((evt) => {
    if (isDetachChord(toKeyEvent(evt))) {
      prevent3(evt);
      session.detach();
      return;
    }
    if (isInterruptChord(toKeyEvent(evt))) {
      prevent3(evt);
      session.interrupt();
      return;
    }
    const bytes = encodeTerminalKey(toKeyEvent(evt));
    if (bytes !== undefined) {
      prevent3(evt);
      session.writeInput(bytes);
    }
  });
  usePaste((event) => {
    try {
      const text = Buffer.from(event.bytes).toString("utf8");
      if (text)
        session.paste(text);
    } catch {}
  });
  const cmd = () => view()?.command;
  const dims = () => {
    const v = view();
    if (!v)
      return `${TERMINAL_FALLBACK_COLS}x${TERMINAL_FALLBACK_ROWS}`;
    return `${v.cols}x${v.viewportRows}`;
  };
  return (() => {
    var _el$ = _$createElement3("box"), _el$2 = _$createElement3("box"), _el$3 = _$createElement3("text"), _el$4 = _$createElement3("span"), _el$5 = _$createTextNode3(`\u2B22 `), _el$9 = _$createElement3("span"), _el$1 = _$createElement3("span"), _el$12 = _$createElement3("text"), _el$13 = _$createElement3("span"), _el$21 = _$createElement3("box"), _el$22 = _$createElement3("box"), _el$23 = _$createElement3("text"), _el$24 = _$createElement3("span"), _el$26 = _$createElement3("span"), _el$28 = _$createElement3("span"), _el$30 = _$createElement3("span"), _el$32 = _$createElement3("span"), _el$34 = _$createElement3("text"), _el$35 = _$createElement3("span"), _el$36 = _$createTextNode3(` \xB7 `), _el$37 = _$createTextNode3(` bytes`);
    _$insertNode3(_el$, _el$2);
    _$insertNode3(_el$, _el$21);
    _$insertNode3(_el$, _el$22);
    _$setProp3(_el$, "flexDirection", "column");
    _$setProp3(_el$, "width", "100%");
    _$setProp3(_el$, "height", "100%");
    _$setProp3(_el$, "padding", 1);
    _$insertNode3(_el$2, _el$3);
    _$insertNode3(_el$2, _el$12);
    _$setProp3(_el$2, "flexDirection", "row");
    _$setProp3(_el$2, "justifyContent", "space-between");
    _$setProp3(_el$2, "flexShrink", 0);
    _$insertNode3(_el$3, _el$4);
    _$insertNode3(_el$3, _el$9);
    _$insertNode3(_el$3, _el$1);
    _$insertNode3(_el$4, _el$5);
    _$insert3(_el$4, () => cmd()?.title ?? "Terminal", null);
    _$insert3(_el$3, _$createComponent3(Show3, {
      get when() {
        return cmd();
      },
      get children() {
        var _el$6 = _$createElement3("span"), _el$7 = _$createTextNode3(` \u2502 `), _el$8 = _$createTextNode3(` \u2502 `);
        _$insertNode3(_el$6, _el$7);
        _$insertNode3(_el$6, _el$8);
        _$insert3(_el$6, () => [cmd().command, ...cmd().args].join(" "), _el$8);
        _$insert3(_el$6, () => cmd().status, null);
        _$insert3(_el$6, (() => {
          var _c$ = _$memo3(() => cmd().exitCode !== undefined);
          return () => _c$() ? ` (${cmd().exitCode})` : "";
        })(), null);
        _$effect3((_$p) => _$setProp3(_el$6, "style", {
          fg: theme().textMuted
        }, _$p));
        return _el$6;
      }
    }), _el$9);
    _$insertNode3(_el$9, _$createTextNode3(` \u2502 `));
    _$insert3(_el$1, () => view()?.connectionDetail ?? "connecting\u2026");
    _$insert3(_el$3, _$createComponent3(Show3, {
      get when() {
        return (view()?.activeBuffer ?? "normal") === "alternate";
      },
      get children() {
        var _el$10 = _$createElement3("span");
        _$insertNode3(_el$10, _$createTextNode3(` \u2502 alt-screen`));
        _$effect3((_$p) => _$setProp3(_el$10, "style", {
          fg: theme().accent
        }, _$p));
        return _el$10;
      }
    }), null);
    _$insertNode3(_el$12, _el$13);
    _$insert3(_el$13, dims, null);
    _$insert3(_el$13, () => view()?.live ? " \xB7 live" : "", null);
    _$insert3(_el$, _$createComponent3(Show3, {
      get when() {
        return view()?.invalid;
      },
      get children() {
        var _el$14 = _$createElement3("box"), _el$15 = _$createElement3("text"), _el$16 = _$createElement3("span"), _el$17 = _$createTextNode3(`Invalid terminal route: `), _el$18 = _$createElement3("span"), _el$19 = _$createTextNode3(`
Press Ctrl+] to go back. Nothing was subscribed or written.`);
        _$insertNode3(_el$14, _el$15);
        _$setProp3(_el$14, "flexDirection", "column");
        _$setProp3(_el$14, "border", true);
        _$setProp3(_el$14, "padding", 1);
        _$setProp3(_el$14, "flexShrink", 0);
        _$insertNode3(_el$15, _el$16);
        _$insertNode3(_el$15, _el$18);
        _$insertNode3(_el$16, _el$17);
        _$insert3(_el$16, () => view()?.invalid, null);
        _$insertNode3(_el$18, _el$19);
        _$effect3((_p$) => {
          var _v$ = theme().error, _v$2 = {
            fg: theme().error,
            bold: true
          }, _v$3 = {
            fg: theme().textMuted
          };
          _v$ !== _p$.e && (_p$.e = _$setProp3(_el$14, "borderColor", _v$, _p$.e));
          _v$2 !== _p$.t && (_p$.t = _$setProp3(_el$16, "style", _v$2, _p$.t));
          _v$3 !== _p$.a && (_p$.a = _$setProp3(_el$18, "style", _v$3, _p$.a));
          return _p$;
        }, {
          e: undefined,
          t: undefined,
          a: undefined
        });
        return _el$14;
      }
    }), _el$21);
    _$use3((el) => {
      viewportEl = el;
      try {
        el.onSizeChange = () => measureViewport();
      } catch {}
      setTimeout(measureViewport, 50);
    }, _el$21);
    _$setProp3(_el$21, "flexDirection", "column");
    _$setProp3(_el$21, "flexGrow", 1);
    _$setProp3(_el$21, "minHeight", 0);
    _$setProp3(_el$21, "overflow", "hidden");
    _$insert3(_el$21, _$createComponent3(Show3, {
      get when() {
        return _$memo3(() => !!view())() && view().rows.length > 0;
      },
      get fallback() {
        return (() => {
          var _el$38 = _$createElement3("text"), _el$39 = _$createElement3("span");
          _$insertNode3(_el$38, _el$39);
          _$insert3(_el$39, () => view()?.invalid ? "" : "(no output yet)");
          _$effect3((_$p) => _$setProp3(_el$39, "style", {
            fg: theme().textMuted
          }, _$p));
          return _el$38;
        })();
      },
      get children() {
        return _$createComponent3(For3, {
          get each() {
            return buildTerminalRows(view().rows, view().cols, view().viewportRows, view().cursor);
          },
          children: (runs) => (() => {
            var _el$40 = _$createElement3("text");
            _$setProp3(_el$40, "wrapMode", "none");
            _$setProp3(_el$40, "truncate", true);
            _$insert3(_el$40, _$createComponent3(For3, {
              each: runs,
              children: (run) => (() => {
                var _el$41 = _$createElement3("span");
                _$insert3(_el$41, () => run.text);
                _$effect3((_$p) => _$setProp3(_el$41, "style", {
                  fg: run.cursor ? theme().background : run.inverse ? run.fg ?? theme().background : run.fg ?? theme().text,
                  bg: run.cursor ? theme().primary : run.inverse ? run.bg ?? theme().text : run.bg,
                  bold: run.bold ?? run.cursor,
                  underline: run.underline
                }, _$p));
                return _el$41;
              })()
            }));
            return _el$40;
          })()
        });
      }
    }));
    _$insertNode3(_el$22, _el$23);
    _$insertNode3(_el$22, _el$34);
    _$setProp3(_el$22, "flexDirection", "row");
    _$setProp3(_el$22, "justifyContent", "space-between");
    _$setProp3(_el$22, "flexShrink", 0);
    _$insertNode3(_el$23, _el$24);
    _$insertNode3(_el$23, _el$26);
    _$insertNode3(_el$23, _el$28);
    _$insertNode3(_el$23, _el$30);
    _$insertNode3(_el$23, _el$32);
    _$insertNode3(_el$24, _$createTextNode3(`type to write \xB7 `));
    _$insertNode3(_el$26, _$createTextNode3(`Ctrl+C`));
    _$insertNode3(_el$28, _$createTextNode3(` interrupt \xB7 `));
    _$insertNode3(_el$30, _$createTextNode3(`Ctrl+]`));
    _$insertNode3(_el$32, _$createTextNode3(` detach (keeps running)`));
    _$insertNode3(_el$34, _el$35);
    _$insertNode3(_el$35, _el$36);
    _$insertNode3(_el$35, _el$37);
    _$insert3(_el$35, dims, _el$36);
    _$insert3(_el$35, () => view()?.totalBytes ?? 0, _el$37);
    _$effect3((_p$) => {
      var _v$4 = {
        fg: theme().primary,
        bold: true
      }, _v$5 = {
        fg: theme().textMuted
      }, _v$6 = {
        fg: view()?.connection === "stream" ? theme().success : view()?.connection === "polling" ? theme().warning : theme().error
      }, _v$7 = {
        fg: theme().textMuted
      }, _v$8 = {
        fg: theme().textMuted
      }, _v$9 = {
        fg: theme().warning,
        bold: true
      }, _v$0 = {
        fg: theme().textMuted
      }, _v$1 = {
        fg: theme().warning,
        bold: true
      }, _v$10 = {
        fg: theme().textMuted
      }, _v$11 = {
        fg: theme().textMuted
      };
      _v$4 !== _p$.e && (_p$.e = _$setProp3(_el$4, "style", _v$4, _p$.e));
      _v$5 !== _p$.t && (_p$.t = _$setProp3(_el$9, "style", _v$5, _p$.t));
      _v$6 !== _p$.a && (_p$.a = _$setProp3(_el$1, "style", _v$6, _p$.a));
      _v$7 !== _p$.o && (_p$.o = _$setProp3(_el$13, "style", _v$7, _p$.o));
      _v$8 !== _p$.i && (_p$.i = _$setProp3(_el$24, "style", _v$8, _p$.i));
      _v$9 !== _p$.n && (_p$.n = _$setProp3(_el$26, "style", _v$9, _p$.n));
      _v$0 !== _p$.s && (_p$.s = _$setProp3(_el$28, "style", _v$0, _p$.s));
      _v$1 !== _p$.h && (_p$.h = _$setProp3(_el$30, "style", _v$1, _p$.h));
      _v$10 !== _p$.r && (_p$.r = _$setProp3(_el$32, "style", _v$10, _p$.r));
      _v$11 !== _p$.d && (_p$.d = _$setProp3(_el$35, "style", _v$11, _p$.d));
      return _p$;
    }, {
      e: undefined,
      t: undefined,
      a: undefined,
      o: undefined,
      i: undefined,
      n: undefined,
      s: undefined,
      h: undefined,
      r: undefined,
      d: undefined
    });
    return _el$;
  })();
}

// src/v2/native-rpc.ts
var NATIVE_RPC_ID = "loopd.native";
var requestSchema = {
  type: "object",
  properties: {
    requestID: { type: "string" },
    goalID: { type: "string" },
    parentSessionID: { type: "string" },
    title: { type: "string" },
    agent: { type: "string" },
    model: {
      type: "object",
      properties: {
        id: { type: "string" },
        providerID: { type: "string" }
      },
      required: ["id", "providerID"],
      additionalProperties: false
    },
    permissions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          action: { type: "string" },
          resource: { type: "string" },
          effect: { type: "string", enum: ["allow", "deny", "ask"] }
        },
        required: ["action", "resource", "effect"],
        additionalProperties: false
      }
    },
    directory: { type: "string" }
  },
  required: ["requestID", "goalID", "parentSessionID", "title"],
  additionalProperties: false
};
var claimResultSchema = {
  type: "object",
  properties: {
    requestID: { type: "string" },
    claimantID: { type: "string" }
  },
  required: ["requestID", "claimantID"],
  additionalProperties: false
};
var claimAckSchema = {
  type: "object",
  properties: {
    requestID: { type: "string" },
    claimantID: { type: "string" },
    won: { type: "boolean" }
  },
  required: ["requestID", "claimantID", "won"],
  additionalProperties: false
};
var createResultSchema = {
  type: "object",
  properties: {
    requestID: { type: "string" },
    childSessionID: { type: "string" },
    parentSessionID: { type: "string" },
    topology: { type: "string", const: "v2-native-child" }
  },
  required: ["requestID", "childSessionID", "parentSessionID", "topology"],
  additionalProperties: false
};
var failureSchema = {
  type: "object",
  properties: {
    requestID: { type: "string" },
    reason: { type: "string" },
    detail: { type: "string" },
    preCreation: { type: "boolean" }
  },
  required: ["requestID", "reason", "preCreation"],
  additionalProperties: false
};
var emptySchema = {
  type: "object",
  properties: {},
  additionalProperties: false
};
var nativeRpcDefinition = {
  id: NATIVE_RPC_ID,
  methods: {
    claimRequest: { input: claimResultSchema, output: claimAckSchema, errors: {} },
    completeWorkerCreate: { input: createResultSchema, output: emptySchema, errors: {} },
    failRequest: { input: failureSchema, output: emptySchema, errors: {} }
  },
  events: {
    workerCreateRequested: { schema: requestSchema }
  }
};

// src/v2/native-tui.ts
function subscribeNativeRequests(rpcClient, deps) {
  return rpcClient.events.on("workerCreateRequested", (event) => {
    const request = event?.data;
    if (!request || typeof request.requestID !== "string")
      return;
    const directory = event?.location?.directory;
    const options = typeof directory === "string" && directory.length > 0 ? { location: { directory } } : undefined;
    handleWorkerCreateRequest(request, {
      ...deps,
      claim: (input) => rpcClient.claimRequest(input, options).then((ack) => ({ won: ack?.won === true })),
      complete: (result) => rpcClient.completeWorkerCreate(result, options),
      fail: (failure) => rpcClient.failRequest(failure, options)
    }).then((outcome) => {
      try {
        deps.onOutcome?.(outcome, request.requestID);
      } catch {}
    }, () => {});
  });
}
async function handleWorkerCreateRequest(request, deps) {
  const parent = deps.data.session.get(request.parentSessionID);
  if (!parent)
    return { handled: "ignored-unknown-parent" };
  if (deps.isKnownParent && !deps.isKnownParent(request.parentSessionID)) {
    return { handled: "ignored-unknown-parent" };
  }
  const { won } = await deps.claim({ requestID: request.requestID, claimantID: deps.claimantID });
  if (!won)
    return { handled: "claim-lost" };
  const fail = (reason, preCreation, detail) => deps.fail({ requestID: request.requestID, reason, preCreation, detail }).then(() => ({
    handled: "failed",
    reason,
    preCreation
  }));
  let forkInput;
  try {
    const messages = deps.data.session.message.list(request.parentSessionID);
    const firstID = messages[0]?.id;
    forkInput = firstID ? { sessionID: request.parentSessionID, before: firstID } : { sessionID: request.parentSessionID };
  } catch (error) {
    return fail("message-list-failed", true, error instanceof Error ? error.message : String(error));
  }
  let child;
  try {
    child = await deps.client.session.fork(forkInput);
  } catch (error) {
    return fail("fork-failed", true, error instanceof Error ? error.message : String(error));
  }
  if (child.parentID !== request.parentSessionID) {
    return fail("parent-mismatch", false, `child.parentID=${JSON.stringify(child.parentID)} expected=${JSON.stringify(request.parentSessionID)}`);
  }
  try {
    if (request.agent && deps.client.session.switchAgent) {
      await deps.client.session.switchAgent({ sessionID: child.id, agent: request.agent });
    }
    if (request.model && deps.client.session.switchModel) {
      await deps.client.session.switchModel({ sessionID: child.id, model: request.model });
    }
    if (deps.client.session.update) {
      await deps.client.session.update({ sessionID: child.id, title: request.title });
    }
  } catch (error) {
    return fail("configure-failed", false, error instanceof Error ? error.message : String(error));
  }
  await deps.complete({
    requestID: request.requestID,
    childSessionID: child.id,
    parentSessionID: request.parentSessionID,
    topology: "v2-native-child"
  });
  return { handled: "completed", childSessionID: child.id, forkInput };
}

// src/tui/plugin.tsx
var PLUGIN_ID = "opencode-loopd.tui";
function navigateToTerminalV1(api, commandID, ownerSessionID, returnSessionID) {
  const payload = terminalRoutePayload(commandID, ownerSessionID, returnSessionID);
  try {
    api.route.navigate(TERMINAL_ROUTE_NAME, payload);
    api.ui.dialog.clear();
    return true;
  } catch {
    return false;
  }
}
var tui = async (api) => {
  const directory = api.state.path.directory;
  let terminalRouteAvailable = false;
  let unregisterTerminalRoute;
  try {
    unregisterTerminalRoute = api.route.register([{
      name: TERMINAL_ROUTE_NAME,
      render: ({
        params
      }) => _$createComponent4(TerminalView, {
        api,
        directory,
        data: params
      })
    }]);
    terminalRouteAvailable = true;
  } catch {
    terminalRouteAvailable = false;
  }
  const openTerminal = (commandID, ownerSessionID, returnSessionID) => {
    if (terminalRouteAvailable && navigateToTerminalV1(api, commandID, ownerSessionID, returnSessionID))
      return;
    const previousFocus = api.renderer.currentFocusedRenderable;
    api.ui.dialog.replace(() => _$createComponent4(CommandPanel, {
      api,
      directory,
      ownerSessionID,
      onOpenCommand: (payload) => openTerminal(payload.commandID, payload.ownerSessionID, payload.returnSessionID)
    }));
    api.ui.dialog.setSize("xlarge");
    previousFocus?.blur();
  };
  const open = () => {
    const previousFocus = api.renderer.currentFocusedRenderable;
    api.ui.dialog.replace(() => _$createComponent4(LoopDashboard, {
      api,
      directory
    }));
    api.ui.dialog.setSize("xlarge");
    previousFocus?.blur();
  };
  const openCommands = () => {
    const previousFocus = api.renderer.currentFocusedRenderable;
    api.ui.dialog.replace(() => _$createComponent4(LoopDashboard, {
      api,
      directory,
      initialView: "commands",
      get ownerSessionID() {
        return currentRouteSessionID(api);
      },
      onOpenCommand: (payload) => openTerminal(payload.commandID, payload.ownerSessionID, payload.returnSessionID)
    }));
    api.ui.dialog.setSize("xlarge");
    previousFocus?.blur();
  };
  api.keymap.registerLayer({
    commands: [{
      name: "opencode.loopd.dashboard",
      title: "Loop Dashboard",
      category: "Loop",
      namespace: "palette",
      slashName: "loop",
      run: open
    }, {
      name: "opencode.loopd.commands",
      title: "Command Sessions",
      category: "Loop",
      namespace: "palette",
      slashName: "commands",
      run: openCommands
    }],
    bindings: [{
      key: "<leader>o",
      cmd: "opencode.loopd.dashboard",
      desc: "Open loop dashboard"
    }]
  });
  api.lifecycle.onDispose(() => {
    try {
      unregisterTerminalRoute?.();
    } catch {}
  });
};
function adaptThemeV2(theme) {
  const t = theme ?? {};
  const text = t.text ?? {};
  const fb = text.feedback ?? {};
  const bg = t.background ?? {};
  const raised = bg.raised ?? bg.surface ?? {};
  const diff = t.diff ?? {};
  const diffText = diff.text ?? {};
  const diffBg = diff.background ?? {};
  const diffHi = diff.highlight ?? {};
  const diffLn = diff.lineNumber ?? {};
  const syntax = t.syntax ?? {};
  const md = t.markdown ?? {};
  const pick = (...values) => values.find((value) => value !== undefined && value !== null);
  const base = pick(text.base, text.default, "#ffffff");
  const muted = pick(text.muted, text.subdued, "#888888");
  const primary = pick(t.hue?.interactive?.[200], text.formfield?.focused, text.action?.primary?.selected, base);
  const accent = pick(t.hue?.accent?.[200], text.action?.primary?.focused, primary);
  const background = pick(bg.base, bg.default, "#000000");
  return {
    text: base,
    textMuted: muted,
    primary,
    secondary: pick(t.hue?.accent?.[300], accent),
    accent,
    success: pick(fb.success?.base, fb.success?.default, "#22c55e"),
    warning: pick(fb.warning?.base, fb.warning?.default, "#eab308"),
    error: pick(fb.error?.base, fb.error?.default, "#ef4444"),
    info: pick(fb.info?.base, fb.info?.default, accent),
    selectedListItemText: pick(text.action?.primary?.focused, base),
    background,
    backgroundPanel: pick(raised.base, raised.overlay, background),
    backgroundElement: pick(raised.high, raised.offset, background),
    backgroundMenu: pick(raised.max, raised.high, background),
    border: pick(t.border?.base, muted),
    borderActive: pick(t.scrollbar?.base, primary),
    borderSubtle: pick(t.border?.base, muted),
    diffAdded: pick(diffText.added, base),
    diffRemoved: pick(diffText.removed, base),
    diffContext: pick(diffText.context, muted),
    diffHunkHeader: pick(diffText.hunkHeader, accent),
    diffAddedBg: pick(diffBg.added, background),
    diffRemovedBg: pick(diffBg.removed, background),
    diffContextBg: pick(diffBg.context, background),
    diffHighlightAdded: pick(diffHi.added, base),
    diffHighlightRemoved: pick(diffHi.removed, base),
    diffLineNumber: pick(diffLn.text, muted),
    diffAddedLineNumberBg: pick(diffLn.background?.added, background),
    diffRemovedLineNumberBg: pick(diffLn.background?.removed, background),
    syntaxComment: pick(syntax.comment, muted),
    syntaxKeyword: pick(syntax.keyword, base),
    syntaxFunction: pick(syntax.function, base),
    syntaxVariable: pick(syntax.variable, base),
    syntaxString: pick(syntax.string, base),
    syntaxNumber: pick(syntax.number, base),
    syntaxType: pick(syntax.type, base),
    syntaxOperator: pick(syntax.operator, base),
    syntaxPunctuation: pick(syntax.punctuation, muted),
    markdownText: pick(md.text, base),
    markdownHeading: pick(md.heading, primary),
    markdownLink: pick(md.link, accent),
    markdownLinkText: pick(md.linkText, accent),
    markdownCode: pick(md.code, base),
    markdownBlockQuote: pick(md.blockQuote, muted),
    markdownEmph: pick(md.emphasis, base),
    markdownStrong: pick(md.strong, base),
    markdownHorizontalRule: pick(md.horizontalRule, muted),
    markdownListItem: pick(md.listItem, accent),
    markdownListEnumeration: pick(md.listEnumeration, accent),
    markdownImage: pick(md.image, accent),
    markdownImageText: pick(md.imageText, base),
    markdownCodeBlock: pick(md.codeBlock, base),
    thinkingOpacity: 0.6,
    _hasSelectedListItemText: true
  };
}
function navigateToTerminalV2(router, commandID, ownerSessionID, returnSessionID) {
  try {
    router.navigate({
      type: "plugin",
      name: TERMINAL_ROUTE_NAME,
      data: terminalRoutePayload(commandID, ownerSessionID, returnSessionID)
    });
    return true;
  } catch {
    return false;
  }
}
var v2setup = (ctx) => {
  const directory = ctx.location?.directory ?? ctx.data.location.default().directory;
  const claimantID = `tui-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
  let unsubscribeNative;
  try {
    const rpcClient = ctx.client.rpc(nativeRpcDefinition);
    unsubscribeNative = subscribeNativeRequests(rpcClient, {
      client: {
        session: {
          fork: (input) => ctx.client.session.fork(input),
          switchAgent: (input) => ctx.client.session.switchAgent(input),
          switchModel: (input) => ctx.client.session.switchModel(input),
          update: (input) => ctx.client.session.update(input)
        }
      },
      data: {
        session: {
          get: (sessionID) => {
            const session = ctx.data.session.get(sessionID);
            return session ? {
              id: session.id
            } : undefined;
          },
          message: {
            list: (sessionID) => ctx.data.session.message.list(sessionID).map((message) => ({
              id: message.id
            }))
          }
        }
      },
      claimantID,
      onOutcome: (outcome, requestID) => {
        try {
          const {
            appendFileSync
          } = __require("fs");
          appendFileSync("/tmp/loopd-tui.log", `[${new Date().toISOString()}] native-worker request=${requestID} outcome=${JSON.stringify(outcome)}
`);
        } catch {}
      },
      isKnownParent: (parentSessionID) => {
        const parent = ctx.data.session.get(parentSessionID);
        if (!parent)
          return false;
        const parentDirectory = parent.location?.directory;
        if (!parentDirectory)
          return true;
        return parentDirectory === directory;
      }
    });
  } catch {
    unsubscribeNative = undefined;
  }
  let dialogOpen = false;
  const closeDialog = () => {
    dialogOpen = false;
    ctx.ui.dialog.clear();
  };
  const facade = {
    theme: {
      get current() {
        return adaptThemeV2(ctx.theme);
      }
    },
    mode: {
      push: (name) => ctx.keymap.mode.push(name)
    },
    renderer: ctx.renderer,
    client: ctx.client,
    event: {
      on: (name, callback) => {
        if (name === "session.idle")
          return ctx.data.on("session.idle", callback);
        if (name === "session.status") {
          const unsubs = [ctx.data.on("session.execution.started", callback), ctx.data.on("session.execution.succeeded", callback)];
          return () => void unsubs.forEach((un) => un());
        }
        if (name === "session.error")
          return ctx.data.on("session.execution.failed", callback);
        if (name === "session.compacted")
          return ctx.data.on("session.compaction.ended", callback);
        return ctx.data.on(name, callback);
      }
    },
    ui: {
      dialog: {
        clear: closeDialog,
        get open() {
          return dialogOpen;
        },
        replace: (render) => {
          dialogOpen = true;
          ctx.ui.dialog.show(render);
        },
        setSize: (_size) => ctx.ui.dialog.set({
          size: "xlarge"
        })
      }
    },
    route: {
      get current() {
        const current = ctx.ui.router.current();
        return current.type === "session" ? {
          name: "session",
          params: {
            sessionID: current.sessionID
          }
        } : {
          name: current.type,
          params: {}
        };
      },
      navigate: (name, params) => {
        if (name === "session")
          ctx.ui.router.navigate({
            type: "session",
            sessionID: params?.sessionID
          });
      }
    }
  };
  let terminalRouteAvailable = false;
  let unregisterTerminalRoute;
  try {
    unregisterTerminalRoute = ctx.ui.router.register({
      name: TERMINAL_ROUTE_NAME,
      render: ({
        data
      }) => _$createComponent4(TerminalView, {
        api: facade,
        directory,
        data
      })
    });
    terminalRouteAvailable = true;
  } catch {
    terminalRouteAvailable = false;
  }
  const openTerminal = (commandID, ownerSessionID, returnSessionID) => {
    if (!terminalRouteAvailable)
      return false;
    const ok = navigateToTerminalV2(ctx.ui.router, commandID, ownerSessionID, returnSessionID);
    if (ok) {
      try {
        ctx.ui.panel.close();
      } catch {}
      closeDialog();
    }
    return ok;
  };
  const open = () => {
    const previousFocus = ctx.renderer.currentFocusedRenderable;
    dialogOpen = true;
    ctx.ui.dialog.show(() => _$createComponent4(LoopDashboard, {
      api: facade,
      directory
    }), () => {
      dialogOpen = false;
    });
    ctx.ui.dialog.set({
      size: "xlarge"
    });
    previousFocus?.blur();
  };
  const openCommands = () => {
    const previousFocus = ctx.renderer.currentFocusedRenderable;
    dialogOpen = true;
    ctx.ui.dialog.show(() => _$createComponent4(LoopDashboard, {
      api: facade,
      directory,
      initialView: "commands",
      ownerSessionID: undefined,
      onOpenCommand: (payload) => {
        openTerminal(payload.commandID, payload.ownerSessionID, payload.returnSessionID);
      }
    }), () => {
      dialogOpen = false;
    });
    ctx.ui.dialog.set({
      size: "xlarge"
    });
    previousFocus?.blur();
  };
  const command = "opencode.loopd.dashboard";
  const commandsCommand = "opencode.loopd.commands";
  const commandsPanel = "opencode.loopd.commands";
  const unclaimCommandPanel = ctx.ui.slot({
    append: "session.panel",
    render: (input) => input.name === commandsPanel ? _$createComponent4(LoopDashboard, {
      api: facade,
      directory,
      initialView: "commands",
      get ownerSessionID() {
        return input.sessionID;
      },
      onOpenCommand: (payload) => {
        openTerminal(payload.commandID, payload.ownerSessionID, payload.returnSessionID);
      },
      isActive: () => input.focused !== false
    }) : null
  });
  let layerRegistered = false;
  const unclaimSlot = ctx.ui.slot({
    append: "app",
    render: () => {
      if (!layerRegistered) {
        layerRegistered = true;
        ctx.keymap.layer(() => ({
          commands: [{
            id: command,
            title: "Loop Dashboard",
            group: "Loop",
            palette: true,
            slash: {
              name: "loop"
            },
            bind: "<leader>o",
            run: open
          }, {
            id: commandsCommand,
            title: "Command Sessions",
            group: "Loop",
            palette: true,
            slash: {
              name: "commands"
            },
            run: () => {
              if (!ctx.ui.panel.open(commandsPanel, {
                presentation: "fullscreen"
              }))
                openCommands();
            }
          }],
          bindings: [command]
        }));
      }
      return null;
    }
  });
  return () => {
    closeDialog();
    ctx.ui.panel.close();
    try {
      unsubscribeNative?.();
    } catch {}
    try {
      unregisterTerminalRoute?.();
    } catch {}
    unclaimCommandPanel();
    unclaimSlot();
  };
};
var plugin_default = {
  id: PLUGIN_ID,
  tui,
  setup: v2setup
};
export {
  adaptThemeV2,
  plugin_default as default,
  navigateToTerminalV1,
  navigateToTerminalV2
};
