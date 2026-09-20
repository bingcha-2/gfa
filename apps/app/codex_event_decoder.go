package main

import "bytes"

const codexObservedEventLimit = 1024 * 1024

// Bounded observational decoder. Its limits never change the bytes forwarded.
type codexEventDecoder struct {
	mode                        byte
	line, event                 []byte
	name                        string
	lineOverflow, eventOverflow bool
	emit                        func(string, []byte)
	onLimit                     func()
}

func (d *codexEventDecoder) write(p []byte) {
	if d.mode == 0 {
		p = bytes.TrimLeft(p, " \t\r\n")
		if len(p) == 0 {
			return
		}
		d.mode = 's'
		if p[0] == '{' || p[0] == '[' {
			d.mode = 'j'
		}
	}
	if d.mode == 'j' {
		if len(d.event)+len(p) > codexObservedEventLimit {
			if !d.eventOverflow && d.onLimit != nil {
				d.onLimit()
			}
			d.event = nil
			d.eventOverflow = true
		}
		if !d.eventOverflow {
			d.event = append(d.event, p...)
		}
		return
	}
	for _, b := range p {
		if b == '\n' {
			d.consumeLine()
			continue
		}
		if d.lineOverflow {
			continue
		}
		if len(d.line) >= codexObservedEventLimit {
			if d.onLimit != nil {
				d.onLimit()
			}
			d.line = nil
			d.lineOverflow = true
			continue
		}
		d.line = append(d.line, b)
	}
}

func (d *codexEventDecoder) consumeLine() {
	if d.lineOverflow {
		d.lineOverflow = false
		d.eventOverflow = true
		d.line = nil
		return
	}
	line := bytes.TrimSuffix(d.line, []byte{'\r'})
	if len(line) == 0 {
		d.consumeEvent()
	} else if bytes.HasPrefix(line, []byte("event:")) {
		d.name = string(bytes.TrimSpace(line[6:]))
	} else if bytes.HasPrefix(line, []byte("data:")) && !d.eventOverflow {
		data := bytes.TrimPrefix(line[5:], []byte{' '})
		if len(d.event)+len(data)+1 > codexObservedEventLimit {
			if d.onLimit != nil {
				d.onLimit()
			}
			d.event = nil
			d.eventOverflow = true
		} else {
			d.event = append(d.event, data...)
			d.event = append(d.event, '\n')
		}
	}
	d.line = nil
}

func (d *codexEventDecoder) consumeEvent() {
	if !d.eventOverflow && len(d.event) > 0 {
		d.emit(d.name, d.event)
	}
	d.name = ""
	d.event = nil
	d.eventOverflow = false
}

func (d *codexEventDecoder) finish() {
	if d.mode == 's' && (len(d.line) > 0 || d.lineOverflow) {
		d.consumeLine()
	}
	d.consumeEvent()
}
