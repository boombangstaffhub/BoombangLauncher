// Autoclick CEROSIETE V.2 — same keys, same speed and same 6 clicks per tick as the original VB.NET program,
// running hidden inside BoomBang Launcher.
//   F3  -> remember the current mouse position as the target
//   F1  -> start clicking            F2 -> stop
//
// What changed (the mouse stays free):
//   * If the target is inside a BoomBang window of the launcher, the helper does NOT touch your mouse at all.
//     It prints "C x y" and the launcher delivers the 6 clicks straight into the game at that point.
//   * If the target is somewhere else, it falls back to the original method (move, 6 clicks, move back), but
//     everything is sent in ONE SendInput call, so your own mouse movement can't get mixed in between.
// Written in C# 5 so Windows PowerShell 5.1 (Add-Type) can compile it on any Windows 10/11.
using System;
using System.Diagnostics;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Windows.Forms;

public static class BBAutoclick
{
    [StructLayout(LayoutKind.Sequential)] private struct POINT { public int X; public int Y; }
    [StructLayout(LayoutKind.Sequential)] private struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)] private struct INPUT { public uint type; public MOUSEINPUT mi; }

    [DllImport("user32.dll")] private static extern short GetAsyncKeyState(int vKey);
    [DllImport("user32.dll")] private static extern bool GetCursorPos(out POINT p);
    [DllImport("user32.dll")] private static extern IntPtr WindowFromPoint(POINT p);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll")] private static extern uint SendInput(uint n, INPUT[] inputs, int size);
    [DllImport("user32.dll")] private static extern int GetSystemMetrics(int index);
    [DllImport("user32.dll")] private static extern bool SetProcessDPIAware();

    private const uint MOVE = 0x0001, LEFTDOWN = 0x0002, LEFTUP = 0x0004, ABSOLUTE = 0x8000, VIRTUALDESK = 0x4000;
    private const int VK_F1 = 0x70, VK_F2 = 0x71, VK_F3 = 0x72;
    private const int CLICKS = 6;

    private static Timer clickTimer, keyTimer, posTimer, parentTimer;
    private static bool hasTarget;
    private static POINT target;
    private static int parentPid;

    private static bool Pressed(int vk) { return GetAsyncKeyState(vk) != 0; }

    // Is the target point on a window that belongs to the launcher (the game windows live in its main process)?
    private static bool TargetIsInLauncher()
    {
        if (parentPid <= 0) return false;
        IntPtr hwnd = WindowFromPoint(target);
        if (hwnd == IntPtr.Zero) return false;
        uint pid; GetWindowThreadProcessId(hwnd, out pid);
        return pid == (uint)parentPid;
    }

    private static INPUT Mouse(uint flags, int x, int y)
    {
        INPUT i = new INPUT(); i.type = 0; i.mi.dx = x; i.mi.dy = y; i.mi.dwFlags = flags; return i;
    }
    private static INPUT MoveTo(POINT p)
    {
        int vx = GetSystemMetrics(76), vy = GetSystemMetrics(77), vw = GetSystemMetrics(78), vh = GetSystemMetrics(79);
        int ax = (int)(((long)(p.X - vx) * 65535) / Math.Max(1, vw - 1));
        int ay = (int)(((long)(p.Y - vy) * 65535) / Math.Max(1, vh - 1));
        return Mouse(MOVE | ABSOLUTE | VIRTUALDESK, ax, ay);
    }

    // Timer1_Tick of the original
    private static void ClickTick(object sender, EventArgs e)
    {
        if (!hasTarget) return;                    // the original crashed here if F3 had never been pressed
        if (TargetIsInLauncher())
        {
            Console.Out.WriteLine("C " + target.X + " " + target.Y);   // the launcher clicks inside the game; your mouse is untouched
            Console.Out.Flush();
            return;
        }
        POINT back; GetCursorPos(out back);
        INPUT[] batch = new INPUT[2 + CLICKS * 2];
        int k = 0;
        batch[k++] = MoveTo(target);
        for (int i = 0; i < CLICKS; i++) { batch[k++] = Mouse(LEFTDOWN, 0, 0); batch[k++] = Mouse(LEFTUP, 0, 0); }
        batch[k++] = MoveTo(back);
        SendInput((uint)batch.Length, batch, Marshal.SizeOf(typeof(INPUT)));   // one atomic burst
    }

    // Timer2_Tick of the original: F1 starts, F2 stops
    private static void KeyTick(object sender, EventArgs e)
    {
        if (Pressed(VK_F1) && !clickTimer.Enabled) { clickTimer.Start(); Console.Out.WriteLine("S 1"); Console.Out.Flush(); }
        if (Pressed(VK_F2) && clickTimer.Enabled) { clickTimer.Stop(); Console.Out.WriteLine("S 0"); Console.Out.Flush(); }
    }

    // Timer3_Tick of the original: F3 stores the mouse position
    private static void PosTick(object sender, EventArgs e)
    {
        if (!Pressed(VK_F3)) return;
        POINT p; GetCursorPos(out p);
        if (!hasTarget || p.X != target.X || p.Y != target.Y) { target = p; hasTarget = true; Console.Out.WriteLine("T " + p.X + " " + p.Y); Console.Out.Flush(); }
    }

    // Not in the original: quit when the launcher is gone, so nothing keeps clicking in the background.
    private static void ParentTick(object sender, EventArgs e)
    {
        if (parentPid <= 0) return;
        try { Process p = Process.GetProcessById(parentPid); if (p.HasExited) Application.Exit(); }
        catch (ArgumentException) { Application.Exit(); }
    }

    public static void Run(int launcherPid, int intervalMs)
    {
        try { SetProcessDPIAware(); } catch (Exception) { }     // real pixel coordinates on scaled screens (125%, 150%...)
        parentPid = launcherPid;
        clickTimer = new Timer(); clickTimer.Interval = Math.Max(1, intervalMs); clickTimer.Tick += ClickTick;
        keyTimer = new Timer(); keyTimer.Interval = 1; keyTimer.Tick += KeyTick; keyTimer.Start();
        posTimer = new Timer(); posTimer.Interval = 1; posTimer.Tick += PosTick; posTimer.Start();
        parentTimer = new Timer(); parentTimer.Interval = 2000; parentTimer.Tick += ParentTick; parentTimer.Start();
        Application.Run(new ApplicationContext());  // no window, just the message loop for the timers
    }
}
