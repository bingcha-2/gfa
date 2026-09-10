package main

import "testing"

func TestTasklistContainsImage(t *testing.T) {
	for _, tc := range []struct {
		name, output string
		want         bool
	}{
		{"Chinese no processes", "信息: 没有运行的任务匹配指定标准。\r\n", false},
		{"English no processes", "INFO: No tasks are running which match the specified criteria.\r\n", false},
		{"empty", "", false},
		{"running", "\"Codex.exe\",\"1234\",\"Console\",\"1\",\"123,456 K\"\r\n", true},
		{"case insensitive", "\"codex.EXE\",\"42\",\"Console\",\"1\",\"100 K\"", true},
		{"different image", "\"OtherCodex.exe\",\"1234\",\"Console\"", false},
		{"not a process record", "Codex.exe could not be found", false},
		{"invalid pid", "\"Codex.exe\",\"not-a-pid\"", false},
		{"multiple rows", "\"other.exe\",\"1\"\r\n\"Codex.exe\",\"2\"\r\n", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := tasklistContainsImage(tc.output, "Codex.exe"); got != tc.want {
				t.Fatalf("got %v, want %v", got, tc.want)
			}
		})
	}
}
