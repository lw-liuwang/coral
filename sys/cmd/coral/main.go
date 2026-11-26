package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"coral/internal/coral"
)

func run() error {
	flags := flag.NewFlagSet("coral", flag.ContinueOnError)
	configFile := flags.String("config", "", "YAML configuration file")
	stdio := flags.Bool("stdio", false, "serve MCP over standard input/output")
	version := flags.Bool("version", false, "print version")
	address := flags.String("listen", "", "HTTP address (for example 127.0.0.1:8300)")
	data := flags.String("data-dir", "", "knowledge-base data directory")
	if err := flags.Parse(os.Args[1:]); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return nil
		}
		return err
	}
	if *version {
		fmt.Printf("coral %s (Go)\n", coral.Version)
		return nil
	}
	config, err := coral.LoadConfig(*configFile)
	if err != nil {
		return err
	}
	if *data != "" {
		config.DataDir, err = filepath.Abs(*data)
		if err != nil {
			return err
		}
	}
	app, err := coral.NewApp(config)
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if *stdio {
		return app.RunStdio(ctx)
	}
	listen := *address
	if listen == "" {
		listen = net.JoinHostPort(config.Server.Host, fmt.Sprint(config.Server.Port))
	}
	listener, err := net.Listen("tcp", listen)
	if err != nil {
		return err
	}
	server := &http.Server{Handler: app, ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 64 * 1024}
	fmt.Printf("coral: http://%s\nMCP: http://%s/mcp\n", listener.Addr(), listener.Addr())
	done := make(chan error, 1)
	go func() { done <- server.Serve(listener) }()
	select {
	case err := <-done:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	case <-ctx.Done():
		shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		return server.Shutdown(shutdown)
	}
}
func main() {
	if err := run(); err != nil {
		log.SetFlags(0)
		log.Printf("coral: %v", err)
		os.Exit(1)
	}
}
