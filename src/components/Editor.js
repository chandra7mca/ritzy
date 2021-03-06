import React from 'react/addons'
import classNames from 'classnames'
import Spinner from 'react-spinkit'
import _ from 'lodash'

import EditorActions from '../flux/EditorActions'
import EditorStore from '../flux/EditorStore'
import EditorLine from './EditorLine'
import Cursor from './Cursor'
import DebugEditor from './DebugEditor'
import { BASE_CHAR, EOF } from '../core/RichText'
import { elementPosition } from '../core/dom'
import SwarmClientMixin from './SwarmClientMixin'
import TextReplicaMixin from './TextReplicaMixin'
import SharedCursorMixin from './SharedCursorMixin'
import TextInput from './TextInput'
import {ATTR, hasAttributeFor} from '../core/attributes'
import { charEq, linesEq, lineContainingChar } from '../core/EditorCommon'
import ReactUtils from '../core/ReactUtils'
import { sourceOf } from '../core/replica'
import TextFontMetrics from '../core/TextFontMetrics'

require('../styles/internal.less')

const T = React.PropTypes

export default React.createClass({
  propTypes: {
    id: T.string.isRequired,
    eventEmitter: T.object.isRequired,
    fonts: T.shape({
      regular: T.object,
      bold: T.object,
      boldItalic: T.object,
      italic: T.object
    }),
    fontSize: T.number.isRequired,
    minFontSize: T.number.isRequired,
    unitsPerEm: T.number.isRequired,
    width: T.number.isRequired,
    margin: T.shape({
      horizontal: T.number,
      vertical: T.number
    }).isRequired,
    userId: T.string.isRequired,
    userName: T.string,
    cursorColorSpace: T.arrayOf(T.string), // TODO allow it to be a function as well
    initialFocus: T.bool,
    wsPort: T.number,
    renderOptimizations: T.bool,
    debugEditor: T.bool,
    showErrorNotification: T.bool,
    errorNotification: T.string
  },

  mixins: [SwarmClientMixin, TextReplicaMixin, SharedCursorMixin],

  getDefaultProps() {
    return {
      initialFocus: true,
      // The default cursor color space is a less harsh variation of the 11 Boynton colors:
      // http://alumni.media.mit.edu/~wad/color/palette.html
      // See also:
      // http://stackoverflow.com/a/4382138/430128
      // https://eleanormaclure.files.wordpress.com/2011/03/colour-coding.pdf
      cursorColorSpace: [
        'rgb(29, 105, 20)',   // green
        'rgb(129, 38, 192)',  // purple,
        'rgb(42, 75, 215)',   // blue
        'rgb(41, 208, 208)',  // cyan
        'rgb(173, 35, 35)',   // red
        'rgb(255, 146, 51)',  // orange
        'rgb(129, 197, 122)', // light green
        'rgb(157, 175, 255)', // light blue
        'rgb(255, 205, 243)', // pink
        'rgb(255, 238, 51)',  // yellow
        'rgb(129, 74, 25)'    // brown
      ],
      renderOptimizations: true,
      debugEditor: false,
      showErrorNotification: true,
      errorNotification: 'There was an unexpected error. You may need to refresh the page.'
    }
  },

  getInitialState() {
    return EditorStore.getState()
  },

  componentWillMount() {
    TextFontMetrics.setConfig(this.props)

    this._createReplica()
    EditorActions.initialize(this.props, this.replica)
  },

  componentWillReceiveProps(nextProps) {
    TextFontMetrics.setConfig(this.props)
    EditorActions.initialize(nextProps, this.replica)

    if(this.props.fontSize !== nextProps.fontSize || this.props.width !== nextProps.width) {
      EditorActions.reflow()
    }
  },

  componentDidMount() {
    this.clickCount = 0
    EditorStore.listen(this.onStateChange)
  },

  shouldComponentUpdate(nextProps, nextState) {
    if(!nextProps.renderOptimizations) {
      return true
    }

    // for better performance make sure objects are immutable so that we can do reference equality checks
    let stateEqual = this.state.loaded === nextState.loaded
      && this.state.focus === nextState.focus
      && this.state.positionEolStart == nextState.positionEolStart
      && this.state.selectionActive == nextState.selectionActive
      && this.state.cursorMotion == nextState.cursorMotion
      && this.state.error === nextState.error
      && ReactUtils.deepEquals(this.state.position, nextState.position, charEq)
      && ReactUtils.deepEquals(this.state.selectionLeftChar, nextState.selectionLeftChar, charEq)
      && ReactUtils.deepEquals(this.state.selectionRightChar, nextState.selectionRightChar, charEq)
      && ReactUtils.deepEquals(this.state.activeAttributes, nextState.activeAttributes)
      && ReactUtils.deepEquals(this.state.remoteNameReveal, nextState.remoteNameReveal)

    if(!stateEqual) return true

    let remoteCursorsIds = this.state.remoteCursors ? Object.keys(this.state.remoteCursors) : []
    let nextRemoteCursorsIds = nextState.remoteCursors ? Object.keys(nextState.remoteCursors) : []
    if(remoteCursorsIds.length !== nextRemoteCursorsIds.length) return true
    for(let i = 0; i < remoteCursorsIds.length; i++) {
      let id = remoteCursorsIds[i]
      if(!ReactUtils.deepEquals(this.state.remoteCursors[id], nextState.remoteCursors[id], _.isEqual,
        [r => r.color, r => r.name, r => r.state])) return true
    }

    if(this.state.lines.length !== nextState.lines.length) return true
    for(let i = 0; i < this.state.lines.length; i++) {
      if(!ReactUtils.deepEquals(this.state.lines[i], nextState.lines[i], linesEq)) return true
    }

    // check props too, even though this check is fast and normally we would do faster checks first,
    // put after state checks b/c Editor props rarely change
    let propsEqual = this.props.fontSize === nextProps.fontSize
      && this.props.minFontSize === nextProps.minFontSize
      && this.props.unitsPerEm === nextProps.unitsPerEm
      && this.props.width === nextProps.width
      && this.props.margin.horizontal === nextProps.margin.horizontal
      && this.props.margin.vertical === nextProps.margin.vertical
      && this.props.userId === nextProps.userId
      && this.props.userName === nextProps.userName
      && this.props.debugEditor === nextProps.debugEditor

    return !propsEqual
  },

  componentWillUnmount() {
    EditorStore.unlisten(this.onStateChange)
  },

  onStateChange(state) {
    this.setState(state)
  },

  _setRenderOptimizations(renderOptimizations) {
    this.setProps({renderOptimizations: renderOptimizations})
  },

  _createReplica() {
    this.createTextReplica()
    this.registerCb(this._replicaInitCb, this._replicaUpdateCb)
  },

  _replicaInitCb(spec, op, replica) {  // eslint-disable-line no-unused-vars
    // set our own replica for future use
    this.replicaSource = sourceOf(spec)
    EditorActions.replicaInitialized()
    this.createSharedCursor()
  },

  _replicaUpdateCb(spec, op, replica) {  // eslint-disable-line no-unused-vars
    if(this.replicaSource === sourceOf(spec)) return
    EditorActions.replicaUpdated()
  },

  _mouseEventToCoordinates(e) {
    // target is the particular element within the editor clicked on, current target is the entire editor div
    let targetPosition = elementPosition(e.currentTarget)

    return {
      x: e.pageX - targetPosition.x,
      y: e.pageY - targetPosition.y
    }
  },

  _doOnSingleClick(e) {
    let coordinates = this._mouseEventToCoordinates(e)
    if(!coordinates) {
      return
    }

    if(e.shiftKey) {
      EditorActions.selectToCoordinates(coordinates)
    } else {
      EditorActions.navigateToCoordinates(coordinates)
    }
  },

  _doOnDoubleClick() {
    EditorActions.selectWordAtCurrentPosition()
  },

  _onMouseDown(e) {
    if(!this.state.focus) {
      EditorActions.focusInput()
    }

    if(this.clickReset) {
      clearTimeout(this.clickReset)
      this.clickReset = null
    }
    let clickCount = this.clickCount
    this.clickCount += 1
    this.clickReset = setTimeout(() => {
      this.clickCount = 0
    }, 250)

    if(clickCount === 0) {
      this._doOnSingleClick(e)
    } else if (clickCount === 1) {
      // note that _doOnSingleClick has already executed here
      this._doOnDoubleClick(e)
    } //else if(this.clickCount === 2) // TODO handle triple-click

    e.preventDefault()
    e.stopPropagation()
  },

  _onMouseMove(e) {
    if(e.buttons !== 1) return

    if(!this.state.focus) {
      EditorActions.focusInput()
    }

    let coordinates = this._mouseEventToCoordinates(e)
    if(!coordinates) return

    EditorActions.selectToCoordinates(coordinates)

    e.preventDefault()
    e.stopPropagation()
  },

  _onMouseUp(e) {
    if(this.state.selectionActive) {
      EditorActions.setActiveAttributes()
    }
  },

  _dismissError() {
    EditorActions.dismissEditorError()
  },

  // RENDERING ---------------------------------------------------------------------------------------------------------

  _searchLinesWithSelection(selection) {
    if(!selection) {
      selection = {
        selectionActive: this.state.selectionActive,
        selectionLeftChar: this.state.selectionLeftChar,
        selectionRightChar: this.state.selectionRightChar
      }
    }

    if(!this.state.lines || this.state.lines.length === 0 || !selection.selectionActive) {
      return null
    }

    let left = lineContainingChar(this.state.lines, this.replica.getCharRelativeTo(selection.selectionLeftChar, 1, 'eof'))
    if(!left) {
      return null
    }

    let right = lineContainingChar(this.state.lines.slice(left.index), selection.selectionRightChar, null)
    if(!right) {
      return null
    }

    return {
      left: left.index,
      right: right.index + left.index
    }
  },

  _computeSelection(lineIndex, lineHeight, selection, linesWithSelection, color) {
    if(!selection.selectionActive) {
      return null
    }

    // lines outside the selection range
    if(linesWithSelection && (lineIndex < linesWithSelection.left || lineIndex > linesWithSelection.right)) {
      return null
    }

    let selectionData = (leftX, widthX) => {
      let height = Math.round(lineHeight * 10) / 10

      // local cursor (no color) without focus is grey
      if(!color && !this.state.focus) {
        color = 'rgb(0, 0, 0)'
      }

      return {
        left: leftX,
        width: widthX,
        height: height,
        color: color
      }
    }

    let line = this.state.lines[lineIndex]

    // middle lines
    if(linesWithSelection && (lineIndex > linesWithSelection.left && lineIndex < linesWithSelection.right)) {
      let selectionWidthX = line.advance
      if(line.isEof() || line.end.char === '\n') {
        selectionWidthX += TextFontMetrics.advanceXForSpace(this.props.fontSize)
      }
      return selectionData(0, selectionWidthX)
    }

    // last line with EOF
    if(line && line.isEof() && selection.selectionRightChar === EOF) {
      return selectionData(0, TextFontMetrics.advanceXForSpace(this.props.fontSize))
    }

    // empty editor (no line and selection is from BASE_CHAR to EOF)
    if(!line
      && charEq(selection.selectionLeftChar, BASE_CHAR)
      && charEq(selection.selectionRightChar, EOF)) {
      return selectionData(0, TextFontMetrics.advanceXForSpace(this.props.fontSize))
    }

    let selectionLeftX = 0
    let selectionWidthX
    let selectionAddSpace

    if(lineIndex === linesWithSelection.left) {
      // TODO change selection height and font size dynamically
      selectionLeftX = TextFontMetrics.advanceXForChars(this.props.fontSize, line.charsTo(selection.selectionLeftChar))
    }

    if(lineIndex === linesWithSelection.right) {
      let selectionChars = selectionLeftX > 0 ?
        line.charsBetween(selection.selectionLeftChar, selection.selectionRightChar) :
        line.charsTo(selection.selectionRightChar)

      if(selectionChars.length === 0) {
        return null
      }
      selectionWidthX = TextFontMetrics.advanceXForChars(this.props.fontSize, selectionChars)
      selectionAddSpace = selectionChars[selectionChars.length - 1].char === '\n'
    } else {
      selectionWidthX = line.advance - selectionLeftX
      selectionAddSpace = line.isEof() || line.end.char === '\n'
    }

    if(selectionAddSpace) {
      selectionWidthX += TextFontMetrics.advanceXForSpace(this.props.fontSize)
    }

    return selectionData(selectionLeftX, selectionWidthX)
  },

  _renderLine(line, index, lineHeight, localSelection, remoteSelections) {
    let computedSelection = localSelection ?
      this._computeSelection(index, lineHeight, localSelection.selection, localSelection.lines) :
      null
    let computedRemoteSelections = remoteSelections
      .filter(s => s)
      .map(s => this._computeSelection(index, lineHeight, s.selection, s.lines, s.color))
      .filter(s => s)

    return (
      <EditorLine key={index} line={line} lineHeight={lineHeight}
        fontSize={this.props.fontSize} selection={computedSelection} remoteSelections={computedRemoteSelections}
        renderOptimizations={this.props.renderOptimizations}/>
    )
  },

  _cursorPosition(lineHeight, position, positionEolStart) {
    // the initial render before the component is mounted has no position or lines
    if (!position || !this.state.lines) {
      return null
    }

    if(charEq(BASE_CHAR, position) || this.state.lines.length === 0) {
      return {
        position: position,
        positionEolStart: positionEolStart,
        left: this.props.margin.horizontal,
        top: this.props.margin.vertical
      }
    }

    let result = lineContainingChar(this.state.lines, position, positionEolStart)
    if(!result) {
      return null
    }
    let {line, index, endOfLine} = result
    let previousLineHeights = line ? lineHeight * index : 0

    let cursorAdvanceX

    if(!line || (endOfLine && positionEolStart && index < this.state.lines.length - 1)) {
      cursorAdvanceX = 0
    } else {
      let positionChars = line.charsTo(position)
      cursorAdvanceX = TextFontMetrics.advanceXForChars(this.props.fontSize, positionChars)
    }

    return {
      position: position,
      positionEolStart: positionEolStart,
      left: this.props.margin.horizontal + cursorAdvanceX,
      top: this.props.margin.vertical + previousLineHeights
    }
  },

  _renderError() {
    if(this.props.showErrorNotification && this.state.error) {
      return (
        <div className="ritzy-error-notification">{ this.props.errorNotification }
          &nbsp; <button className="ritzy-error-notification-dismiss" onClick={this._dismissError}>x</button>
        </div>
      )
    }
  },

  _renderInput(cursorPosition) {
    let left = cursorPosition ? cursorPosition.left : 0
    let top = cursorPosition ? cursorPosition.top : 0
    return (
      <TextInput id={this.props.id} ref="input" coordinates={{x: left, y: top}} focused={this.state.focus}
        renderOptimizations={this.props.renderOptimizations}/>
    )
  },

  _renderCursor(cursorPosition, lineHeight, remote) {
    if(remote) {
      let id = remote._id
      let revealName = this.state.remoteNameReveal.has(id)
      return (
        <Cursor key={id} cursorPosition={cursorPosition} lineHeight={lineHeight}
          remoteNameReveal={revealName} remote={remote} renderOptimizations={this.props.renderOptimizations}/>
      )
    } else {
      return (
        <Cursor key="local" ref="cursor" cursorPosition={cursorPosition} lineHeight={lineHeight}
          cursorMotion={this.state.cursorMotion} activeAttributes={this.state.activeAttributes}
          selectionActive={this.state.selectionActive} focus={this.state.focus}
          renderOptimizations={this.props.renderOptimizations}/>
      )
    }
  },

  _renderRemoteCursors(lineHeight) {
    return Object.keys(this.state.remoteCursors).filter(id => this.state.remoteCursors[id].state.position).map(id => {
      let remoteCursor = this.state.remoteCursors[id]
      let remotePosition
      try {
        remotePosition = this.replica.getChar(remoteCursor.state.position)
      } catch (e) {
        console.warn('Error obtaining remote position, ignoring.', e)
        return null
      }
      // show remote cursors in same position as local one (subtly prompts user to move his local cursor somewhere else)
      if(remotePosition) {
        let cursorPosition = this._cursorPosition(lineHeight, remotePosition, remoteCursor.state.positionEolStart)
        if(cursorPosition) {
          return this._renderCursor(cursorPosition, lineHeight, remoteCursor)
        }
      }
      return null
    })
  },

  _renderEditorContents() {
    if(this.state.loaded) {
      let lineHeight = TextFontMetrics.lineHeight(this.props.fontSize)
      let cursorPosition = this._cursorPosition(lineHeight, this.state.position, this.state.positionEolStart)
      let createSelectionData = (source, color) => {
        let selection = {
          selectionActive: source.selectionActive,
          selectionLeftChar: source.selectionLeftChar,
          selectionRightChar: source.selectionRightChar
        }
        let linesWithSelection = this._searchLinesWithSelection(selection)
        if(!linesWithSelection) {
          return null
        }
        return {
          selection: selection,
          lines: linesWithSelection,
          color: color
        }
      }

      let localSelection = createSelectionData(this.state)
      let remoteSelections = Object.keys(this.state.remoteCursors).filter(id => this.state.remoteCursors[id].state.selectionActive).map(id => {
        let remoteCursor = this.state.remoteCursors[id]
        return createSelectionData(remoteCursor.state, remoteCursor.color)
      })

      return (
        <div>
          {this._renderInput(cursorPosition)}
          <div className="ritzy-internal-text-contents text-contents" style={{position: 'relative'}}>
            { this.state.lines.length > 0 ?
              this.state.lines.map((line, index) => this._renderLine(line, index, lineHeight, localSelection, remoteSelections) ) :
              <EditorLine lineHeight={lineHeight} fontSize={this.props.fontSize} renderOptimizations={this.props.renderOptimizations}/> }
          </div>
          {this._renderCursor(cursorPosition, lineHeight)}
          {this._renderRemoteCursors(lineHeight)}
        </div>
      )
    } else {
      return (
        <Spinner spinnerName='three-bounce' noFadeIn/>
      )
    }
  },

  _renderDebugEditor() {
    if(!this.props.debugEditor) {
      return null
    }
    return (
      <DebugEditor editorState={this.state} replica={this.replica} searchLinesWithSelection={this._searchLinesWithSelection} setRenderOptimizations={this._setRenderOptimizations}/>
    )
  },

  render() {
    //console.trace('render')
    let wrapperStyle = {
      width: this.props.width,
      padding: `${this.props.margin.vertical}px ${this.props.margin.horizontal}px`
    }

    return (
      <div style={{boxSizing: 'content-box'}}>
        {this._renderError()}
        <div className="ritzy-internal-text-content-wrapper text-content-wrapper"
          style={wrapperStyle} onMouseDown={this._onMouseDown} onMouseUp={this._onMouseUp} onMouseMove={this._onMouseMove}>
          {this._renderEditorContents()}
        </div>
        {this._renderDebugEditor()}
      </div>
    )
  }

})
