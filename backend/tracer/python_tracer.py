import sys
import json
import os
import io
import contextlib
import traceback
import ast
import inspect
import copy


# ============================================================
# GLOBAL STATE
# ============================================================

SOURCE_FILE = ""

events = []
call_stack = []

step = 0
frame_counter = 0

conditions = {}

INTERNAL_HELPERS = {
    "_memory_read",
    "_memory_write",
    "_attribute_read",
    "_attribute_write",
    "_semantic_assign",
    "_semantic_aug_assign",
    "_semantic_aug_assign_attr",
    "_condition_check",
    "_loop_iteration",
    "_break_event",
    "_continue_event",
    "_expr_binop",
    "_expr_unary",
    "_expr_compare",
    "_expr_bool_and",
    "_expr_bool_or",
    "_expr_call",
    "_expr_attribute",
    "_expr_subscript"
}

# Python real object id -> our visualization object id
object_ids = {}

# Our visualization object id -> object information
object_registry = {}

object_counter = 0


# ============================================================
# OBJECT ID
# ============================================================

def get_object_id(obj):
    global object_counter

    real_id = id(obj)

    if real_id not in object_ids:
        object_counter += 1
        object_ids[real_id] = f"obj_{object_counter}"

    return object_ids[real_id]


# ============================================================
# CHECK USER OBJECT
# ============================================================

def should_track_object(value):
    """
    Return True only for values that should appear as tracked heap
    objects in the memory visualization.
    """

    if value is None:
        return False

    if isinstance(value, (bool, int, float, str)):
        return False

    if isinstance(value, (dict, list, tuple)):
        return True

    if isinstance(value, type):
        return False

    if inspect.isfunction(value):
        return False

    if inspect.ismethod(value):
        return False

    if inspect.isbuiltin(value):
        return False

    if inspect.ismodule(value):
        return False

    if callable(value):
        return False

    return hasattr(value, "__dict__")


def is_user_object(value):
    """
    Returns True only for actual user-defined objects.
    """

    if value is None:
        return False

    if isinstance(value, (bool, int, float, str, list, tuple, dict)):
        return False

    if isinstance(value, type):
        return False

    if inspect.isfunction(value):
        return False

    if inspect.ismethod(value):
        return False

    if inspect.isbuiltin(value):
        return False

    if inspect.ismodule(value):
        return False

    if callable(value):
        return False

    return hasattr(value, "__dict__")


# ============================================================
# OBJECT REGISTRY
# ============================================================

def register_object(obj):
    """
    Register objects and containers so they can be visualized.
    """

    object_id = get_object_id(obj)

    if object_id in object_registry:
        return object_id

    # Create placeholder first.
    # This prevents problems with self-referencing objects.
    object_registry[object_id] = {
        "type": type(obj).__name__,
        "fields": {}
    }

    fields = {}

    # -------------------------
    # Dictionary
    # -------------------------
    if isinstance(obj, dict):

        for key, value in list(obj.items()):

            field_name = str(key)

            fields[field_name] = get_value(value)


    # -------------------------
    # List / Tuple
    # -------------------------
    elif isinstance(obj, (list, tuple)):

        for index, value in enumerate(obj):

            fields[str(index)] = get_value(value)


    # -------------------------
    # User-defined object
    # -------------------------
    elif hasattr(obj, "__dict__"):

        for name, value in list(obj.__dict__.items()):

            if value is None:

                fields[name] = None

            elif (
                isinstance(value, (dict, list, tuple))
                or hasattr(value, "__dict__")
            ):

                fields[name] = get_value(value)

            else:

                fields[name] = get_value(value)


    object_registry[object_id] = {
        "type": type(obj).__name__,
        "fields": fields
    }

    return object_id


def refresh_object(obj):

    object_id = get_object_id(obj)

    fields = {}

    # -------------------------
    # Dictionary
    # -------------------------
    if isinstance(obj, dict):

        for key, value in list(obj.items()):

            fields[str(key)] = get_value(value)


    # -------------------------
    # List / Tuple
    # -------------------------
    elif isinstance(obj, (list, tuple)):

        for index, value in enumerate(obj):

            fields[str(index)] = get_value(value)


    # -------------------------
    # User-defined object
    # -------------------------
    elif hasattr(obj, "__dict__"):

        for name, value in list(obj.__dict__.items()):

            fields[name] = get_value(value)


    object_registry[object_id] = {
        "type": type(obj).__name__,
        "fields": fields
    }



def refresh_objects_from_frame(frame):
    """
    Find tracked objects in the current frame
    and update the object registry.
    """

    for name, value in frame.f_locals.items():

        if name.startswith("__") or name in INTERNAL_HELPERS:
            continue

        if should_track_object(value):
            refresh_object(value)

    for name, value in frame.f_globals.items():

        if name.startswith("__") or name in INTERNAL_HELPERS:
            continue

        if should_track_object(value):
            refresh_object(value)


# ============================================================
# CONDITIONS
# ============================================================

def load_conditions(source_code):
    global conditions

    tree = ast.parse(source_code)

    conditions = {}

    for node in ast.walk(tree):

        if isinstance(node, ast.If):

            conditions[node.lineno] = ast.unparse(node.test)


# ============================================================
# VALUE CONVERSION
# ============================================================

def get_value(value):
    """
    Convert Python runtime values into JSON-friendly
    structures used by the visualization engine.
    """

    # None
    if value is None:
        return {
            "type": "None",
            "value": None
        }

    # Boolean
    if isinstance(value, bool):
        return {
            "type": "bool",
            "value": value
        }

    # Integer
    if isinstance(value, int):
        return {
            "type": "int",
            "value": value
        }

    # Float
    if isinstance(value, float):
        return {
            "type": "float",
            "value": value
        }

    # String
    if isinstance(value, str):
        return {
            "type": "str",
            "value": value
        }

    # Track containers and user-defined objects as memory objects.
    if should_track_object(value):

        object_id = register_object(value)

        return {
            "type": type(value).__name__,
            "objectId": object_id
        }

    # Function
    if inspect.isfunction(value):

        return {
            "type": "function",
            "name": value.__name__
        }

    # Class
    if isinstance(value, type):

        return {
            "type": "class",
            "name": value.__name__
        }

    # Fallback
    try:

        return {
            "type": type(value).__name__,
            "value": repr(value)
        }

    except Exception:

        return {
            "type": type(value).__name__,
            "value": "<unavailable>"
        }


# ============================================================
# VARIABLES
# ============================================================

def get_variables(frame):

    variables = {}

    for name, value in frame.f_locals.items():

        if name.startswith("__") or name in INTERNAL_HELPERS:
            continue

        try:

            variables[name] = get_value(value)

        except Exception:

            variables[name] = {
                "type": type(value).__name__,
                "value": repr(value)
            }

    return variables


# ============================================================
# REFERENCES
# ============================================================

def get_references(frame):

    references = {}

    for name, value in frame.f_locals.items():

        if name.startswith("__") or name in INTERNAL_HELPERS:
            continue

        if should_track_object(value):

            references[name] = get_object_id(value)

    return references


# ============================================================
# CALL STACK
# ============================================================

def get_stack():

    stack = []

    for frame in call_stack:

        stack.append({
            "frameId": frame["frameId"],
            "parentFrameId": frame["parentFrameId"],
            "function": frame["function"],
            "arguments": frame.get("arguments", {})
        })

    return stack


# ============================================================
# EVENT CREATION
# ============================================================

def add_event(event_type, frame, line=None, extra=None):

    global step

    # Refresh tracked objects from both local and global namespaces so the
    # event snapshot reflects the exact in-memory state at this execution step.
    for namespace in (frame.f_locals, frame.f_globals):

        for name, value in namespace.items():

            if name.startswith("__") or name in INTERNAL_HELPERS:
                continue

            try:

                if should_track_object(value):
                    refresh_object(value)

            except Exception:
                pass

    # Update objects BEFORE taking the variable snapshot.
    refresh_objects_from_frame(frame)

    variables = get_variables(frame)

    references = get_references(frame)

    event = {
        "step": step,
        "line": line if line is not None else frame.f_lineno,
        "event": event_type,
        "function": frame.f_code.co_name,
        "frameId": call_stack[-1]["frameId"] if call_stack else None,

        "variables": variables,

        "references": references,

        "objects": copy.deepcopy(object_registry),

        "callStack": get_stack()
    }

    if extra:
        event.update(extra)

    events.append(event)

    step += 1


# ============================================================
# MEMORY READ
# ============================================================

def memory_read(container, key, line):

    frame = inspect.currentframe().f_back

    try:

        value = container[key]

        add_event(
            "MEMORY_READ",
            frame,
            line,
            {
                "containerType": type(container).__name__,
                "key": get_value(key),
                "value": get_value(value)
            }
        )

        # Dictionary lookup successful
        if isinstance(container, dict):

            add_event(
                "CACHE_HIT",
                frame,
                line,
                {
                    "containerType": "dict",
                    "key": get_value(key),
                    "value": get_value(value)
                }
            )

        return value

    except (KeyError, IndexError):

        if isinstance(container, dict):

            add_event(
                "CACHE_MISS",
                frame,
                line,
                {
                    "containerType": "dict",
                    "key": get_value(key)
                }
            )

        raise


# ============================================================
# MEMORY WRITE
# ============================================================

def memory_write(container, key, value, line):

    frame = inspect.currentframe().f_back

    container[key] = value

    add_event(
        "MEMORY_WRITE",
        frame,
        line,
        {
            "containerType": type(container).__name__,
            "key": get_value(key),
            "value": get_value(value)
        }
    )

    return value


# ============================================================
# CONTROL FLOW HELPERS
# ============================================================


def condition_check(test_value, line, condition_text, kind="if"):
    """
    Observe the actual condition value at execution time without re-evaluating.
    """

    frame = inspect.currentframe().f_back
    result = bool(test_value)

    add_event(
        "CONDITION",
        frame,
        line,
        {
            "condition": condition_text,
            "result": result,
            "kind": kind
        }
    )

    add_event(
        "CONDITION_EVALUATED",
        frame,
        line,
        {
            "condition": condition_text,
            "result": result
        }
    )

    return result


def loop_iteration(loop_type, target_name, value, line, description):
    """
    Observe one actual loop-body iteration using the runtime value.
    """

    frame = inspect.currentframe().f_back

    target = None
    if target_name:
        target = {
            "kind": "name",
            "name": target_name
        }

    add_event(
        "LOOP_ITERATION",
        frame,
        line,
        {
            "loopType": loop_type,
            "target": target,
            "value": get_value(value) if value is not None else None,
            "description": description
        }
    )

    return value


def break_event(line, description):
    """
    Observe a true runtime break without altering control flow.
    """

    frame = inspect.currentframe().f_back

    add_event(
        "BREAK",
        frame,
        line,
        {
            "description": description
        }
    )

    return None


def continue_event(line, description):
    """
    Observe a true runtime continue without altering control flow.
    """

    frame = inspect.currentframe().f_back

    add_event(
        "CONTINUE",
        frame,
        line,
        {
            "description": description
        }
    )

    return None


# ============================================================
# EXPRESSION HELPERS
# ============================================================


def emit_expression_result(frame, expression_desc, operands, result_value, line):
    add_event(
        "EXPRESSION_RESULT",
        frame,
        line,
        {
            "expression": expression_desc,
            "operands": operands,
            "result": get_value(result_value)
        }
    )

    return result_value


def expr_binop(operator, left, right, line, expr_desc):
    frame = inspect.currentframe().f_back

    if operator == "+":
        result = left + right
    elif operator == "-":
        result = left - right
    elif operator == "*":
        result = left * right
    elif operator == "/":
        result = left / right
    elif operator == "//":
        result = left // right
    elif operator == "%":
        result = left % right
    elif operator == "**":
        result = left ** right
    elif operator == "<<":
        result = left << right
    elif operator == ">>":
        result = left >> right
    elif operator == "&":
        result = left & right
    elif operator == "|":
        result = left | right
    elif operator == "^":
        result = left ^ right
    elif operator == "@":
        result = left @ right
    else:
        result = left

    emit_expression_result(
        frame,
        expr_desc,
        {
            "left": get_value(left),
            "right": get_value(right)
        },
        result,
        line
    )

    return result


def expr_unary(operator, operand, line, expr_desc):
    frame = inspect.currentframe().f_back

    if operator == "+":
        result = +operand
    elif operator == "-":
        result = -operand
    elif operator == "~":
        result = ~operand
    elif operator == "not":
        result = not operand
    else:
        result = operand

    emit_expression_result(
        frame,
        expr_desc,
        {"operand": get_value(operand)},
        result,
        line
    )

    return result


def expr_compare(left, comparators, operators, line, expr_desc):
    frame = inspect.currentframe().f_back

    left_value = left
    result = True

    for op, comparator in zip(operators, comparators):
        if op == "==":
            current = left_value == comparator
        elif op == "!=":
            current = left_value != comparator
        elif op == "<":
            current = left_value < comparator
        elif op == "<=":
            current = left_value <= comparator
        elif op == ">":
            current = left_value > comparator
        elif op == ">=":
            current = left_value >= comparator
        elif op == "is":
            current = left_value is comparator
        elif op == "is not":
            current = left_value is not comparator
        elif op == "in":
            current = left_value in comparator
        elif op == "not in":
            current = left_value not in comparator
        else:
            current = bool(left_value)

        result = result and current
        left_value = comparator

    emit_expression_result(
        frame,
        expr_desc,
        {
            "left": get_value(left),
            "comparators": [get_value(item) for item in comparators],
            "operators": operators
        },
        result,
        line
    )

    return result


def expr_bool_and(left, right_factory, line, expr_desc):
    frame = inspect.currentframe().f_back

    if left:
        right_value = right_factory()
        result = left and right_value
    else:
        right_value = None
        result = left

    operands = {
        "left": get_value(left),
        "right": get_value(right_value) if right_value is not None else {"type": "skipped", "value": "not evaluated"}
    }

    emit_expression_result(frame, expr_desc, operands, result, line)

    return result


def expr_bool_or(left, right_factory, line, expr_desc):
    frame = inspect.currentframe().f_back

    if left:
        right_value = None
        result = left
    else:
        right_value = right_factory()
        result = left or right_value

    operands = {
        "left": get_value(left),
        "right": get_value(right_value) if right_value is not None else {"type": "skipped", "value": "not evaluated"}
    }

    emit_expression_result(frame, expr_desc, operands, result, line)

    return result


def expr_call(func, args, kwargs, line, expr_desc):
    frame = inspect.currentframe().f_back

    result = func(*args, **kwargs)

    emit_expression_result(
        frame,
        expr_desc,
        {
            "function": get_value(func),
            "arguments": [get_value(value) for value in args],
            "keywords": {
                key: get_value(value)
                for key, value in kwargs.items()
            }
        },
        result,
        line
    )

    return result


def expr_attribute(obj, attr_name, line, expr_desc):
    frame = inspect.currentframe().f_back

    value = attribute_read(obj, attr_name, line, {"kind": "attribute", "attribute": attr_name})

    emit_expression_result(
        frame,
        expr_desc,
        {
            "object": get_value(obj),
            "attribute": attr_name
        },
        value,
        line
    )

    return value


def expr_subscript(container, key, line, expr_desc):
    frame = inspect.currentframe().f_back

    value = memory_read(container, key, line)

    emit_expression_result(
        frame,
        expr_desc,
        {
            "container": get_value(container),
            "key": get_value(key)
        },
        value,
        line
    )

    return value


# ============================================================
# SEMANTIC DESCRIPTION
# ============================================================

def describe_ast(node):
    """
    Build a static description of an AST node without evaluating user code.
    This is metadata only for semantic tracing.
    """

    if node is None:
        return {"kind": "none"}

    if isinstance(node, ast.Constant):
        return {
            "kind": "constant",
            "value": node.value
        }

    if isinstance(node, ast.Name):
        return {
            "kind": "name",
            "name": node.id
        }

    if isinstance(node, ast.Attribute):
        return {
            "kind": "attribute",
            "object": describe_ast(node.value),
            "attribute": node.attr
        }

    if isinstance(node, ast.Call):
        return {
            "kind": "call",
            "function": describe_ast(node.func),
            "arguments": [describe_ast(arg) for arg in node.args],
            "keywords": [
                {
                    "arg": kw.arg,
                    "value": describe_ast(kw.value)
                }
                for kw in node.keywords
            ]
        }

    if isinstance(node, ast.BinOp):
        return {
            "kind": "binary_op",
            "operator": type(node.op).__name__,
            "left": describe_ast(node.left),
            "right": describe_ast(node.right)
        }

    if isinstance(node, ast.UnaryOp):
        return {
            "kind": "unary_op",
            "operator": type(node.op).__name__,
            "operand": describe_ast(node.operand)
        }

    if isinstance(node, ast.Compare):
        return {
            "kind": "compare",
            "left": describe_ast(node.left),
            "ops": [type(op).__name__ for op in node.ops],
            "comparators": [describe_ast(item) for item in node.comparators]
        }

    if isinstance(node, ast.BoolOp):
        return {
            "kind": "bool_op",
            "op": type(node.op).__name__,
            "values": [describe_ast(value) for value in node.values]
        }

    if isinstance(node, ast.Subscript):
        return {
            "kind": "subscript",
            "value": describe_ast(node.value),
            "slice": describe_ast(node.slice)
        }

    if isinstance(node, ast.Tuple):
        return {
            "kind": "tuple",
            "items": [describe_ast(item) for item in node.elts]
        }

    if isinstance(node, ast.List):
        return {
            "kind": "list",
            "items": [describe_ast(item) for item in node.elts]
        }

    if isinstance(node, ast.Dict):
        return {
            "kind": "dict",
            "keys": [describe_ast(key) for key in node.keys],
            "values": [describe_ast(value) for value in node.values]
        }

    if isinstance(node, ast.IfExp):
        return {
            "kind": "if_exp",
            "test": describe_ast(node.test),
            "body": describe_ast(node.body),
            "orelse": describe_ast(node.orelse)
        }

    if isinstance(node, ast.NamedExpr):
        return {
            "kind": "named_expr",
            "target": describe_ast(node.target),
            "value": describe_ast(node.value)
        }

    return {
        "kind": type(node).__name__
    }


def ast_literal_from_value(value):
    """
    Convert a Python literal structure into an AST literal node.
    This keeps the metadata valid for compile() without evaluating user code.
    """

    if value is None:
        return ast.Constant(value=None)

    if isinstance(value, (str, int, float, bool)):
        return ast.Constant(value=value)

    if isinstance(value, list):
        return ast.List(
            elts=[ast_literal_from_value(item) for item in value],
            ctx=ast.Load()
        )

    if isinstance(value, tuple):
        return ast.Tuple(
            elts=[ast_literal_from_value(item) for item in value],
            ctx=ast.Load()
        )

    if isinstance(value, dict):
        return ast.Dict(
            keys=[ast_literal_from_value(key) for key in value.keys()],
            values=[ast_literal_from_value(val) for val in value.values()]
        )

    return ast.Constant(value=str(value))


# ============================================================
# SEMANTIC EVENT HELPERS
# ============================================================

def semantic_assign(name, value, line, rhs_desc):
    """
    Observe a runtime assignment without re-evaluating the RHS.
    """

    frame = inspect.currentframe().f_back

    add_event(
        "ASSIGNMENT",
        frame,
        line,
        {
            "target": {
                "kind": "name",
                "name": name
            },
            "value": get_value(value),
            "rhs": rhs_desc
        }
    )

    return value


def semantic_aug_assign(name, operator, current_value, rhs_value, line, rhs_desc):
    """
    Observe augmented assignment using the actual runtime value flow.
    """

    frame = inspect.currentframe().f_back
    old_value = current_value

    if operator == "+=":
        result = old_value + rhs_value
    elif operator == "-=":
        result = old_value - rhs_value
    elif operator == "*=":
        result = old_value * rhs_value
    elif operator == "/=":
        result = old_value / rhs_value
    elif operator == "%=":
        result = old_value % rhs_value
    else:
        result = old_value

    add_event(
        "AUG_ASSIGNMENT",
        frame,
        line,
        {
            "target": {
                "kind": "name",
                "name": name
            },
            "operator": operator,
            "oldValue": get_value(old_value),
            "value": get_value(result),
            "rhs": rhs_desc
        }
    )

    return result


def semantic_aug_assign_attr(obj, attr_name, operator, rhs_value, line, rhs_desc):
    """
    Observe attribute augmented assignment using the actual runtime value flow.
    """

    frame = inspect.currentframe().f_back

    sentinel = object()
    old_value = getattr(obj, attr_name, sentinel)

    if operator == "+=":
        result = old_value + rhs_value
    elif operator == "-=":
        result = old_value - rhs_value
    elif operator == "*=":
        result = old_value * rhs_value
    elif operator == "/=":
        result = old_value / rhs_value
    elif operator == "%=":
        result = old_value % rhs_value
    else:
        result = old_value

    setattr(obj, attr_name, result)

    add_event(
        "AUG_ASSIGNMENT",
        frame,
        line,
        {
            "target": {
                "kind": "attribute",
                "objectId": get_object_id(obj),
                "attribute": attr_name
            },
            "operator": operator,
            "oldValue": get_value(old_value) if old_value is not sentinel else None,
            "value": get_value(result),
            "rhs": rhs_desc
        }
    )

    return result


def attribute_read(obj, attr_name, line, rhs_desc):
    """
    Observe actual attribute reads without re-executing the user expression.
    """

    frame = inspect.currentframe().f_back

    value = getattr(obj, attr_name)

    add_event(
        "ATTRIBUTE_READ",
        frame,
        line,
        {
            "target": {
                "kind": "attribute",
                "objectId": get_object_id(obj),
                "attribute": attr_name
            },
            "value": get_value(value),
            "rhs": rhs_desc
        }
    )

    return value


def attribute_write(obj, attr_name, value, line, rhs_desc):
    """
    Observe actual attribute writes before mutating the object.
    """

    frame = inspect.currentframe().f_back

    sentinel = object()
    old_value = getattr(obj, attr_name, sentinel)

    setattr(obj, attr_name, value)

    add_event(
        "ATTRIBUTE_WRITE",
        frame,
        line,
        {
            "target": {
                "kind": "attribute",
                "objectId": get_object_id(obj),
                "attribute": attr_name
            },
            "oldValue": get_value(old_value) if old_value is not sentinel else None,
            "value": get_value(value),
            "rhs": rhs_desc
        }
    )

    return value


# ============================================================
# AST MEMORY TRANSFORMER
# ============================================================

class MemoryTransformer(ast.NodeTransformer):

    def _make_bool_lambda(self, body):
        return ast.Lambda(
            args=ast.arguments(
                posonlyargs=[],
                args=[],
                vararg=None,
                kwonlyargs=[],
                kw_defaults=[],
                kwarg=None,
                defaults=[]
            ),
            body=body
        )

    def visit_If(self, node):

        node = self.generic_visit(node)

        node.test = ast.Call(
            func=ast.Name(id="_condition_check", ctx=ast.Load()),
            args=[
                node.test,
                ast.Constant(node.lineno),
                ast.Constant(ast.unparse(node.test)),
                ast.Constant("if")
            ],
            keywords=[]
        )

        return node

    def visit_While(self, node):

        node = self.generic_visit(node)

        node.test = ast.Call(
            func=ast.Name(id="_condition_check", ctx=ast.Load()),
            args=[
                node.test,
                ast.Constant(node.lineno),
                ast.Constant(ast.unparse(node.test)),
                ast.Constant("while")
            ],
            keywords=[]
        )

        loop_event = ast.Expr(
            value=ast.Call(
                func=ast.Name(id="_loop_iteration", ctx=ast.Load()),
                args=[
                    ast.Constant("while"),
                    ast.Constant(None),
                    ast.Constant(None),
                    ast.Constant(node.lineno),
                    ast.Constant(ast.unparse(node.test))
                ],
                keywords=[]
            )
        )

        node.body = [loop_event] + node.body

        return node

    def visit_For(self, node):

        node = self.generic_visit(node)

        target_name = None
        if isinstance(node.target, ast.Name):
            target_name = node.target.id

        target_expr = ast.Constant(None)
        if target_name is not None:
            target_expr = ast.Name(id=target_name, ctx=ast.Load())

        loop_event = ast.Expr(
            value=ast.Call(
                func=ast.Name(id="_loop_iteration", ctx=ast.Load()),
                args=[
                    ast.Constant("for"),
                    ast.Constant(target_name),
                    target_expr,
                    ast.Constant(node.lineno),
                    ast.Constant(ast.unparse(node.iter))
                ],
                keywords=[]
            )
        )

        node.body = [loop_event] + node.body

        return node

    def visit_Break(self, node):

        return [
            ast.Expr(
                value=ast.Call(
                    func=ast.Name(id="_break_event", ctx=ast.Load()),
                    args=[
                        ast.Constant(node.lineno),
                        ast.Constant("break")
                    ],
                    keywords=[]
                )
            ),
            node
        ]

    def visit_Continue(self, node):

        return [
            ast.Expr(
                value=ast.Call(
                    func=ast.Name(id="_continue_event", ctx=ast.Load()),
                    args=[
                        ast.Constant(node.lineno),
                        ast.Constant("continue")
                    ],
                    keywords=[]
                )
            ),
            node
        ]

    def visit_BoolOp(self, node):

        node = self.generic_visit(node)

        helper_name = "_expr_bool_and" if isinstance(node.op, ast.And) else "_expr_bool_or"

        result = node.values[-1]
        for value in reversed(node.values[:-1]):
            result = ast.Call(
                func=ast.Name(id=helper_name, ctx=ast.Load()),
                args=[
                    value,
                    self._make_bool_lambda(result),
                    ast.Constant(node.lineno),
                    ast_literal_from_value(describe_ast(node))
                ],
                keywords=[]
            )

        return ast.copy_location(result, node)

    def visit_BinOp(self, node):

        node = self.generic_visit(node)

        op_map = {
            ast.Add: "+",
            ast.Sub: "-",
            ast.Mult: "*",
            ast.Div: "/",
            ast.FloorDiv: "//",
            ast.Mod: "%",
            ast.Pow: "**",
            ast.LShift: "<<",
            ast.RShift: ">>",
            ast.BitAnd: "&",
            ast.BitOr: "|",
            ast.BitXor: "^",
            ast.MatMult: "@"
        }

        op_name = op_map.get(type(node.op))
        if op_name is None:
            return node

        new_node = ast.Call(
            func=ast.Name(id="_expr_binop", ctx=ast.Load()),
            args=[
                ast.Constant(op_name),
                node.left,
                node.right,
                ast.Constant(node.lineno),
                ast_literal_from_value(describe_ast(node))
            ],
            keywords=[]
        )

        return ast.copy_location(new_node, node)

    def visit_UnaryOp(self, node):

        node = self.generic_visit(node)

        op_map = {
            ast.UAdd: "+",
            ast.USub: "-",
            ast.Not: "not",
            ast.Invert: "~"
        }

        op_name = op_map.get(type(node.op))
        if op_name is None:
            return node

        new_node = ast.Call(
            func=ast.Name(id="_expr_unary", ctx=ast.Load()),
            args=[
                ast.Constant(op_name),
                node.operand,
                ast.Constant(node.lineno),
                ast_literal_from_value(describe_ast(node))
            ],
            keywords=[]
        )

        return ast.copy_location(new_node, node)

    def visit_Compare(self, node):

        node = self.generic_visit(node)

        op_map = {
            ast.Eq: "==",
            ast.NotEq: "!=",
            ast.Lt: "<",
            ast.LtE: "<=",
            ast.Gt: ">",
            ast.GtE: ">=",
            ast.Is: "is",
            ast.IsNot: "is not",
            ast.In: "in",
            ast.NotIn: "not in"
        }

        op_names = [op_map.get(type(op)) for op in node.ops]
        if any(op is None for op in op_names):
            return node

        new_node = ast.Call(
            func=ast.Name(id="_expr_compare", ctx=ast.Load()),
            args=[
                node.left,
                ast.Tuple(elts=node.comparators, ctx=ast.Load()),
                ast.Tuple(elts=[ast.Constant(value) for value in op_names], ctx=ast.Load()),
                ast.Constant(node.lineno),
                ast_literal_from_value(describe_ast(node))
            ],
            keywords=[]
        )

        return ast.copy_location(new_node, node)

    def visit_Call(self, node):

        node = self.generic_visit(node)

        keyword_names = []
        keyword_values = []
        for kw in node.keywords:
            keyword_names.append(ast.Constant(kw.arg))
            keyword_values.append(kw.value)

        new_node = ast.Call(
            func=ast.Name(id="_expr_call", ctx=ast.Load()),
            args=[
                node.func,
                ast.Tuple(elts=node.args, ctx=ast.Load()),
                ast.Dict(
                    keys=keyword_names,
                    values=keyword_values
                ),
                ast.Constant(node.lineno),
                ast_literal_from_value(describe_ast(node))
            ],
            keywords=[]
        )

        return ast.copy_location(new_node, node)

    def visit_Attribute(self, node):

        node = self.generic_visit(node)

        if isinstance(node.ctx, ast.Load):

            new_node = ast.Call(
                func=ast.Name(
                    id="_expr_attribute",
                    ctx=ast.Load()
                ),
                args=[
                    node.value,
                    ast.Constant(node.attr),
                    ast.Constant(node.lineno),
                    ast_literal_from_value(describe_ast(node))
                ],
                keywords=[]
            )

            return ast.copy_location(new_node, node)

        return node

    def visit_Subscript(self, node):

        node = self.generic_visit(node)

        if isinstance(node.ctx, ast.Load):

            new_node = ast.Call(
                func=ast.Name(
                    id="_expr_subscript",
                    ctx=ast.Load()
                ),
                args=[
                    node.value,
                    node.slice,
                    ast.Constant(node.lineno),
                    ast_literal_from_value(describe_ast(node))
                ],
                keywords=[]
            )

            return ast.copy_location(new_node, node)

        return node

    def visit_Assign(self, node):

        node = self.generic_visit(node)

        if len(node.targets) == 1:

            target = node.targets[0]

            if isinstance(target, ast.Attribute):

                new_node = ast.Expr(
                    value=ast.Call(
                        func=ast.Name(
                            id="_attribute_write",
                            ctx=ast.Load()
                        ),
                        args=[
                            target.value,
                            ast.Constant(target.attr),
                            node.value,
                            ast.Constant(node.lineno),
                            ast_literal_from_value(describe_ast(node.value))
                        ],
                        keywords=[]
                    )
                )

                return ast.copy_location(
                    new_node,
                    node
                )

            if isinstance(target, ast.Subscript):

                container = target.value

                key = target.slice

                new_node = ast.Expr(
                    value=ast.Call(
                        func=ast.Name(
                            id="_memory_write",
                            ctx=ast.Load()
                        ),

                        args=[
                            container,
                            key,
                            node.value,
                            ast.Constant(node.lineno)
                        ],

                        keywords=[]
                    )
                )

                return ast.copy_location(
                    new_node,
                    node
                )

            if isinstance(target, ast.Name):

                new_node = ast.Assign(
                    targets=[
                        ast.Name(
                            id=target.id,
                            ctx=ast.Store()
                        )
                    ],
                    value=ast.Call(
                        func=ast.Name(
                            id="_semantic_assign",
                            ctx=ast.Load()
                        ),
                        args=[
                            ast.Constant(target.id),
                            node.value,
                            ast.Constant(node.lineno),
                            ast_literal_from_value(describe_ast(node.value))
                        ],
                        keywords=[]
                    )
                )

                return ast.copy_location(
                    new_node,
                    node
                )

        return node

    def visit_AugAssign(self, node):

        node = self.generic_visit(node)

        target = node.target
        operator = node.op

        if isinstance(operator, ast.Add):
            op_name = "+="
        elif isinstance(operator, ast.Sub):
            op_name = "-="
        elif isinstance(operator, ast.Mult):
            op_name = "*="
        elif isinstance(operator, ast.Div):
            op_name = "/="
        elif isinstance(operator, ast.Mod):
            op_name = "%="
        else:
            return node

        if isinstance(target, ast.Name):

            new_node = ast.Assign(
                targets=[
                    ast.Name(
                        id=target.id,
                        ctx=ast.Store()
                    )
                ],
                value=ast.Call(
                    func=ast.Name(
                        id="_semantic_aug_assign",
                        ctx=ast.Load()
                    ),
                    args=[
                        ast.Constant(target.id),
                        ast.Constant(op_name),
                        ast.Name(
                            id=target.id,
                            ctx=ast.Load()
                        ),
                        node.value,
                        ast.Constant(node.lineno),
                        ast_literal_from_value(describe_ast(node.value))
                    ],
                    keywords=[]
                )
            )

            return ast.copy_location(new_node, node)

        if isinstance(target, ast.Attribute):

            new_node = ast.Expr(
                value=ast.Call(
                    func=ast.Name(
                        id="_semantic_aug_assign_attr",
                        ctx=ast.Load()
                    ),
                    args=[
                        target.value,
                        ast.Constant(target.attr),
                        ast.Constant(op_name),
                        node.value,
                        ast.Constant(node.lineno),
                        ast_literal_from_value(describe_ast(node.value))
                    ],
                    keywords=[]
                )
            )

            return ast.copy_location(new_node, node)

        return node


# ============================================================
# TRACE FUNCTION
# ============================================================

def trace_function(frame, event, arg):

    if frame.f_code.co_filename != SOURCE_FILE:
        return None

    global frame_counter

    # --------------------------------------------------------
    # FUNCTION CALL
    # --------------------------------------------------------

    if event == "call":

        parent_id = None

        if call_stack:

            parent_id = call_stack[-1]["frameId"]

        frame_counter += 1

        frame_info = {
            "frameId": f"f{frame_counter}",

            "parentFrameId": parent_id,

            "function": frame.f_code.co_name,

            "arguments": {
                name: get_value(value)

                for name, value
                in frame.f_locals.items()

                if not name.startswith("__") and name not in INTERNAL_HELPERS
            }
        }

        call_stack.append(frame_info)

        add_event(
            "FUNCTION_ENTER",

            frame,

            frame.f_lineno,

            {
                "arguments": {
                    name: get_value(value)

                    for name, value
                    in frame.f_locals.items()

                    if not name.startswith("__") and name not in INTERNAL_HELPERS
                }
            }
        )

        return trace_function


    # --------------------------------------------------------
    # NO ACTIVE CALL STACK
    # --------------------------------------------------------

    if not call_stack:

        return trace_function


    # --------------------------------------------------------
    # LINE EXECUTION
    # --------------------------------------------------------

    if event == "line":

        add_event(
            "LINE_EXECUTED",

            frame,

            frame.f_lineno
        )


    # --------------------------------------------------------
    # FUNCTION RETURN
    # --------------------------------------------------------

    elif event == "return":

        add_event(
            "FUNCTION_EXIT",

            frame,

            frame.f_lineno,

            {
                "returnValue": get_value(arg)
            }
        )

        if call_stack:

            call_stack.pop()


    # --------------------------------------------------------
    # EXCEPTION
    # --------------------------------------------------------

    elif event == "exception":

        exc_type, exc_value, _ = arg

        add_event(
            "ERROR",

            frame,

            frame.f_lineno,

            {
                "errorType": exc_type.__name__,

                "errorMessage": str(exc_value)
            }
        )


    return trace_function


# ============================================================
# RUN CODE
# ============================================================

def run_code(source_file):

    global SOURCE_FILE
    global events
    global call_stack
    global step
    global frame_counter
    global conditions
    global object_ids
    global object_registry
    global object_counter

    # --------------------------------------------------------
    # RESET EVERYTHING
    # --------------------------------------------------------

    SOURCE_FILE = os.path.abspath(source_file)

    events = []

    call_stack = []

    step = 0

    frame_counter = 0

    conditions = {}

    object_ids = {}

    object_registry = {}

    object_counter = 0


    output_buffer = io.StringIO()


    result = {

        "success": False,

        "events": [],

        "objects": {},

        "references": {},

        "output": "",

        "error": None
    }


    try:

        # ----------------------------------------------------
        # READ SOURCE
        # ----------------------------------------------------

        with open(
            source_file,
            "r"
        ) as file:

            code = file.read()


        # ----------------------------------------------------
        # LOAD CONDITIONS
        # ----------------------------------------------------

        load_conditions(code)


        # ----------------------------------------------------
        # PARSE AST
        # ----------------------------------------------------

        tree = ast.parse(code)


        # ----------------------------------------------------
        # INSTRUMENT MEMORY ACCESS
        # ----------------------------------------------------

        tree = MemoryTransformer().visit(tree)

        ast.fix_missing_locations(tree)


        # ----------------------------------------------------
        # COMPILE
        # ----------------------------------------------------

        compiled_code = compile(

            tree,

            SOURCE_FILE,

            "exec"
        )


        # ----------------------------------------------------
        # START TRACE
        # ----------------------------------------------------

        sys.settrace(trace_function)


        # ----------------------------------------------------
        # EXECUTE USER CODE
        # ----------------------------------------------------

        with contextlib.redirect_stdout(
            output_buffer
        ):

            exec(

                compiled_code,

                {
                    "__name__": "__main__",

                    "_memory_read": memory_read,
                    "_memory_write": memory_write,
                    "_attribute_read": attribute_read,
                    "_attribute_write": attribute_write,
                    "_semantic_assign": semantic_assign,
                    "_semantic_aug_assign": semantic_aug_assign,
                    "_semantic_aug_assign_attr": semantic_aug_assign_attr,
                    "_condition_check": condition_check,
                    "_loop_iteration": loop_iteration,
                    "_break_event": break_event,
                    "_continue_event": continue_event,
                    "_expr_binop": expr_binop,
                    "_expr_unary": expr_unary,
                    "_expr_compare": expr_compare,
                    "_expr_bool_and": expr_bool_and,
                    "_expr_bool_or": expr_bool_or,
                    "_expr_call": expr_call,
                    "_expr_attribute": expr_attribute,
                    "_expr_subscript": expr_subscript
                }
            )


        # ----------------------------------------------------
        # STOP TRACE
        # ----------------------------------------------------

        sys.settrace(None)


        result["success"] = True


    except Exception as e:

        sys.settrace(None)

        result["error"] = {

            "type": type(e).__name__,

            "message": str(e),

            "traceback": traceback.format_exc()
        }


    # --------------------------------------------------------
    # FINAL DATA
    # --------------------------------------------------------

    result["events"] = events

    result["objects"] = object_registry

    result["output"] = output_buffer.getvalue()


    # --------------------------------------------------------
    # FINAL REFERENCES
    # --------------------------------------------------------

    if events:

        # Use the latest event's references
        result["references"] = events[-1].get(
            "references",
            {}
        )


    return result


# ============================================================
# MAIN
# ============================================================

def main():

    if len(sys.argv) < 2:

        print(
            json.dumps(
                {
                    "success": False,

                    "error": {
                        "type": "InputError",

                        "message":
                            "Source file not provided"
                    }
                }
            )
        )

        return


    result = run_code(
        sys.argv[1]
    )


    print(
        json.dumps(
            result,
            indent=2
        )
    )


# ============================================================
# ENTRY POINT
# ============================================================

if __name__ == "__main__":

    main()