ingit
======
[![NPM version](https://badge.fury.io/js/ingit.svg)](http://badge.fury.io/js/ingit)
[![Build Status](https://travis-ci.org/capaj/ingit.svg)](https://travis-ci.org/capaj/ingit)
[![Join the chat at https://gitter.im/capaj/ingit](https://badges.gitter.im/capaj/ingit.svg)](https://gitter.im/capaj/ingit?utm_source=badge&utm_medium=badge&utm_campaign=pr-badge&utm_content=badge)

The easiest way to use git. On any platform. Anywhere.

[![xkcd](xkcd.png)](https://xkcd.com/1597/)

Git is known for being a versatile distributed source control system that is a staple of many individuals, communities, and even for [the City of Chattanooga to crowd source bicycle parking locations](https://github.com/cityofchattanooga/Bicycle-Parking).  However, it is not known for userfriendlyness or easy learning curve.

Ingit is to bring user friendliness to git without sacrificing versatility of git.

 * Clean and intuitive UI that makes it easy to _understand_ git.
 * Runs on any platform that node.js & git supports.
 * Web-based, meaning you can run it on your cloud/pure shell machine and use the ui from your browser (just browse to http://your-cloud-machine.com:8448).
 * Works well with GitHub.

[Follow @ingitui on twitter](https://twitter.com/ingitui)

Quick intro to ingit: [http://youtu.be/hkBVAi3oKvo](http://youtu.be/hkBVAi3oKvo)

[![Screenshot](screenshot.png)](http://youtu.be/hkBVAi3oKvo)

Why the fork?
----------

Ungit is quite an old project and while it is fairly well maintained, it got a bit stale. I use it every day for most of my interaction with git and I really want this kind of UI to be universally used by programmers. I see way too many struggle in the command line. Programmers need their tools fast and reliable. Currently with ungit I don't see how that can be achieved. It's quite hard to contribute to the project, current issues aren't resolved, there are very few maintainers.
This is a vicious cycle that needs to stop. The way I propose to do it is to rewrite most of the code, fix bugs and introduce new features.

What I plan:

* callback style code into async/await style
* instead of grunt use webpack for building assets
* knockout.js should be replaced by react+mobx

Hopefully active people in the react community will notice and help me out.

Installing
----------
Requires [node.js](http://nodejs.org) (≥ 7.0.0), [npm](https://www.npmjs.com/) (≥ 3.0.0, comes with node.js) and [git](http://git-scm.com/) (≥ 1.8.x). To install ingit just type:

	npm install -g ingit

NOTE: If your system requires root access to install global npm packages, make sure you use the -H flag:

	sudo -H npm install -g ingit

Using
-----
Anywhere you want to start, just type:

	ingit

This will launch the server and open up a browser with the ui.

Configuring
---------
Put a configuration file called .ingitrc in your home directory (`/home/USERNAME` on *nix, `C:/Users/USERNAME/` on windows). Can be in either json or ini format. See [source/config.js](source/config.js) for available options.

You can also override configuration variables at launch by specifying them as command line arguments; `ingit --port=8080`. To disable boolean features use --no: `ingit --no-autoFetch`.

Example of `~/.ingitrc` configuration file to change default port and enable bugtracking:

```json
{
	"port": 8080,
	"bugtracking": true
}
```

Ingit uses [rc](https://github.com/dominictarr/rc) for configuration, which in turn uses [yargs](https://github.com/yargs/yargs) for command line arguments. See corresponding documentations for more details.

External Merge Tools
--------------------
If you have your own merge tool that you would like to use, such as Kaleidoscope or p4merge, you can configure ingit to use it. See [MERGETOOL.md](MERGETOOL.md).

Plugins
-------
Plugins are installed by simply placing them in the Ingit plugin directory (`~/.ingit/plugins` by default), and then restarting Ingit.

[List of available plugins](https://github.com/capaj/ingit/wiki/List-of-plugins)

There's a guide in the [PLUGINS.md](PLUGINS.md) file on how to write new plugins.

Text Editor Integration
-------------------

* [atom-ingit](https://github.com/capaj/atom-ingit) for [Atom.io](https://atom.io/) by [@capaj](https://github.com/capaj)

![atom-ingit Screenshot](https://raw.githubusercontent.com/capaj/atom-ingit/master/screenshot.png)

* [atom-bracket](https://github.com/Hirse/brackets-ingit) for [Brackets.io](http://brackets.io/) by [@hirse](https://github.com/Hirse)

![atom-brackets Screenshot](https://raw.githubusercontent.com/Hirse/brackets-ingit/master/screenshots/viewer.png)


Developing
----------

See [CONTRIBUTING.md](CONTRIBUTING.md).

Maintainers
-----------
* [Jiří Špác](https://github.com/capaj)

Known issues
------------

* If you're running MacOSX Mavericks and Ungit crashes after a few seconds; try updating npm and node. See [#259](https://github.com/FredrikNoren/ungit/issues/259) and [#249](https://github.com/FredrikNoren/ungit/issues/249) for details.
* Ubuntu users may have trouble installing because the node executable is named differently on Ubuntu, see [#401](https://github.com/FredrikNoren/ungit/issues/401) for details.
* Debian Wheezy's supported git and nodejs packages are too old, therefore download newest [git](https://github.com/git/git/releases) and [nodejs](https://nodejs.org/download/) tarballs and [build from source](http://www.control-escape.com/linux/lx-swinstall-tar.html).

Changelog
---------
See [CHANGELOG.md](CHANGELOG.md).

License (MIT)
-------------

Copyright (C) 2016 Jiří Špác

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

[![Dependency Status](https://david-dm.org/capaj/ingit.svg)](https://david-dm.org/capaj/ingit)
[![devDependency Status](https://david-dm.org/capaj/ingit/dev-status.svg)](https://david-dm.org/capaj/ingit#info=devDependencies)
